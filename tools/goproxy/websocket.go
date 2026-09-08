package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/elazarl/goproxy"
	"github.com/gobwas/ws"
)

const maxWebSocketMessage = 100 * 1024 * 1024

func isWebSocket(headers http.Header) bool {
	return strings.EqualFold(headers.Get("Upgrade"), "websocket") &&
		strings.Contains(strings.ToLower(headers.Get("Connection")), "upgrade")
}

func (r *runtime) websocketRequest(req *http.Request, pc *goproxy.ProxyCtx, ex *exchange) (*http.Request, *http.Response) {
	session := ex.session
	session.websocket = true
	target := *req.URL
	if target.Scheme == "https" {
		target.Scheme = "wss"
	} else {
		target.Scheme = "ws"
	}
	result, err := r.peer.ask(req.Context(), map[string]any{
		"type": "websocket", "id": session.id, "url": target.String(),
		"headers": nodeHeaders(req.Header), "socket": r.socketMetadata(req),
	})
	if err != nil {
		return req, failedResponse(req, session, err)
	}
	req.Header = httpHeaders(result.Options.Headers)
	// Forward uncompressed frames so message edits preserve payload boundaries.
	req.Header.Del("Sec-WebSocket-Extensions")
	req.Header.Del("Proxy-Authorization")
	req.Header.Del("Proxy-Connection")
	req.RequestURI = ""
	r.setRoundTripper(pc, result.Options, result.Route, ex, true)
	return req, nil
}

func (r *runtime) websocketResponse(resp *http.Response, pc *goproxy.ProxyCtx, ex *exchange) *http.Response {
	if resp == nil || resp.StatusCode != http.StatusSwitchingProtocols {
		return failedResponse(pc.Req, ex.session, errors.New("upstream rejected WebSocket upgrade"))
	}
	body, ok := resp.Body.(*forwardBody)
	if !ok {
		return failedResponse(pc.Req, ex.session, errors.New("missing WebSocket response body"))
	}
	upstream, ok := body.body.(io.ReadWriteCloser)
	if !ok {
		return failedResponse(pc.Req, ex.session, errors.New("upstream is not a WebSocket connection"))
	}
	wsBody := newWebSocketBody(pc.Req.Context(), upstream, ex.session)
	body.body = wsBody
	return resp
}

func (b *forwardBody) Write(data []byte) (int, error) {
	writer, ok := b.body.(io.Writer)
	if !ok {
		return 0, errors.New("response body is not writable")
	}
	return writer.Write(data)
}

type websocketBody struct {
	upstream     io.ReadWriteCloser
	in           *io.PipeReader
	out          *io.PipeWriter
	inputWriter  *io.PipeWriter
	outputReader *io.PipeReader
	session      *session
	once         sync.Once
}

func newWebSocketBody(parent context.Context, upstream io.ReadWriteCloser, session *session) *websocketBody {
	in, inputWriter := io.Pipe()
	outputReader, out := io.Pipe()
	b := &websocketBody{
		upstream: upstream, in: in, inputWriter: inputWriter, out: out, outputReader: outputReader, session: session,
	}
	ctx, cancel := context.WithCancel(parent)
	context.AfterFunc(ctx, func() { closeQuietly(b) })
	session.workers.Go(func() { <-session.done; cancel() })
	transfer := func(source io.Reader, target io.Writer, fromServer bool) {
		err := relayWebSocket(ctx, source, target, session, fromServer)
		if !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrClosedPipe) {
			session.finish(false, err)
		}
		closeQuietly(b)
	}
	session.workers.Go(func() { transfer(upstream, inputWriter, true) })
	session.workers.Go(func() { transfer(outputReader, upstream, false) })
	return b
}

func (b *websocketBody) Read(data []byte) (int, error)  { return b.in.Read(data) }
func (b *websocketBody) Write(data []byte) (int, error) { return b.out.Write(data) }
func (b *websocketBody) Close() error {
	b.once.Do(func() {
		closeQuietly(b.in)
		closeQuietly(b.inputWriter)
		closeQuietly(b.out)
		closeQuietly(b.outputReader)
		closeQuietly(b.upstream)
		b.session.finish(true, nil)
	})
	return nil
}

func relayWebSocket(ctx context.Context, source io.Reader, target io.Writer, session *session, fromServer bool) error {
	state := ws.StateServerSide
	if fromServer {
		state = ws.StateClientSide
	}
	fragments := []ws.Header{}
	payload := []byte{}
	binary := false
	for {
		header, err := ws.ReadHeader(source)
		if err != nil {
			return err
		}
		if err := ws.CheckHeader(header, state); err != nil {
			return fmt.Errorf("invalid WebSocket frame: %w", err)
		}
		if header.Length > maxWebSocketMessage-int64(len(payload)) || len(fragments) >= 65536 {
			return errors.New("WebSocket message exceeds size limit")
		}
		data := make([]byte, int(header.Length))
		if _, err := io.ReadFull(source, data); err != nil {
			return err
		}
		if header.Masked {
			ws.Cipher(data, header.Mask, 0)
		}
		if header.OpCode.IsControl() {
			if header.Masked {
				ws.Cipher(data, header.Mask, 0)
			}
			if err := ws.WriteFrame(target, ws.Frame{Header: header, Payload: data}); err != nil {
				return err
			}
			continue
		}
		if !state.Fragmented() {
			binary = header.OpCode == ws.OpBinary
		}
		fragments = append(fragments, header)
		payload = append(payload, data...)
		if !header.Fin {
			state |= ws.StateFragmented
			continue
		}
		state &^= ws.StateFragmented
		if !binary && !utf8.Valid(payload) {
			return errors.New("invalid WebSocket UTF-8 message")
		}
		frameID := fmt.Sprint(session.runtime.sequence.Add(1))
		result, err := session.runtime.peer.ask(ctx, map[string]any{
			"type": "frame", "id": frameID, "frameId": frameID, "session": session.id,
			"fromServer": fromServer, "data": wireBytes(payload), "binary": binary,
		})
		if err != nil {
			return err
		}
		if err := writeFragments(target, result.Data, result.Binary, fragments); err != nil {
			return err
		}
		fragments = fragments[:0]
		payload = payload[:0]
	}
}

func writeFragments(writer io.Writer, data []byte, binary bool, fragments []ws.Header) error {
	lengths := make([]int, 0, len(fragments))
	original := 0
	for _, header := range fragments {
		lengths = append(lengths, int(header.Length))
		original += int(header.Length)
	}
	if original != len(data) {
		remaining, largest := len(data), 1
		lengths = lengths[:0]
		for _, header := range fragments {
			largest = max(largest, int(header.Length))
			length := min(int(header.Length), remaining)
			lengths = append(lengths, length)
			remaining -= length
			if remaining == 0 {
				break
			}
		}
		for remaining > 0 {
			length := min(remaining, largest)
			lengths = append(lengths, length)
			remaining -= length
		}
	}
	offset := 0
	for index, length := range lengths {
		header := fragments[min(index, len(fragments)-1)]
		header.OpCode = ws.OpContinuation
		if index == 0 {
			header.OpCode = ws.OpText
			if binary {
				header.OpCode = ws.OpBinary
			}
		}
		header.Fin = index == len(lengths)-1
		header.Length = int64(length)
		part := append([]byte{}, data[offset:offset+length]...)
		offset += length
		if header.Masked {
			ws.Cipher(part, header.Mask, 0)
		}
		if err := ws.WriteFrame(writer, ws.Frame{Header: header, Payload: part}); err != nil {
			return err
		}
	}
	return nil
}
