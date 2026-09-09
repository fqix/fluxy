package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
)

const chunkSize = 64 * 1024
const maxMessage = 144 * 1024 * 1024

type wireBytes []byte

func (b wireBytes) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]string{"$bytes": base64.StdEncoding.EncodeToString(b)})
}

func (b *wireBytes) UnmarshalJSON(data []byte) error {
	var value struct {
		Bytes string `json:"$bytes"`
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return fmt.Errorf("decode binary IPC value: %w", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(value.Bytes)
	if err != nil {
		return fmt.Errorf("decode IPC base64: %w", err)
	}
	*b = decoded
	return nil
}

type identity struct {
	Certificate string `json:"certificate"`
	Key         string `json:"key"`
}

type requestOptions struct {
	Method  string          `json:"method"`
	URL     string          `json:"url"`
	Headers map[string]any  `json:"headers"`
	CA      json.RawMessage `json:"ca"`
	Cert    json.RawMessage `json:"cert"`
	Key     json.RawMessage `json:"key"`
}

type message struct {
	Type          string         `json:"type"`
	ID            string         `json:"id,omitempty"`
	Stream        string         `json:"stream,omitempty"`
	Data          wireBytes      `json:"data,omitempty"`
	Trailers      map[string]any `json:"trailers,omitempty"`
	Error         string         `json:"error,omitempty"`
	Host          string         `json:"host,omitempty"`
	Port          int            `json:"port,omitempty"`
	IngressToken  string         `json:"ingressToken,omitempty"`
	IngressPort   int            `json:"ingressPort,omitempty"`
	Root          *identity      `json:"root,omitempty"`
	Identity      *identity      `json:"identity,omitempty"`
	URL           string         `json:"url,omitempty"`
	Route         string         `json:"route,omitempty"`
	Options       requestOptions `json:"options,omitempty"`
	Local         bool           `json:"local,omitempty"`
	Status        int            `json:"status,omitempty"`
	StatusMessage string         `json:"statusMessage,omitempty"`
	Headers       map[string]any `json:"headers,omitempty"`
	Binary        bool           `json:"binary,omitempty"`
}

// peer multiplexes policy replies and bounded body streams over inherited pipes.
// The reader never waits for a body consumer: a stream gets one chunk of credit,
// so a paused breakpoint cannot block cancellation or a different HTTP/2 stream.
type peer struct {
	writer  io.Writer
	writeMu sync.Mutex
	mu      sync.Mutex
	pending map[string]chan message
	readers map[string]*bodyReader
	credits map[string]chan struct{}
	fatal   context.CancelFunc
}

func newPeer(writer io.Writer, fatal context.CancelFunc) *peer {
	return &peer{
		writer: writer, fatal: fatal,
		pending: make(map[string]chan message),
		readers: make(map[string]*bodyReader),
		credits: make(map[string]chan struct{}),
	}
}

func (p *peer) send(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode IPC message: %w", err)
	}
	if len(data) > maxMessage {
		return errors.New("IPC message exceeds size limit")
	}
	frame := make([]byte, 4+len(data))
	binary.BigEndian.PutUint32(frame, uint32(len(data)))
	copy(frame[4:], data)
	p.writeMu.Lock()
	_, err = p.writer.Write(frame)
	p.writeMu.Unlock()
	if err != nil {
		p.fatal()
		return fmt.Errorf("write IPC message: %w", err)
	}
	return nil
}

func readMessage(reader io.Reader) (message, error) {
	var head [4]byte
	if _, err := io.ReadFull(reader, head[:]); err != nil {
		return message{}, fmt.Errorf("read IPC header: %w", err)
	}
	size := binary.BigEndian.Uint32(head[:])
	if size == 0 || size > maxMessage {
		return message{}, errors.New("invalid IPC frame length")
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(reader, data); err != nil {
		return message{}, fmt.Errorf("read IPC body: %w", err)
	}
	var msg message
	if err := json.Unmarshal(data, &msg); err != nil {
		return message{}, fmt.Errorf("decode IPC message: %w", err)
	}
	return msg, nil
}

func (p *peer) reply(key string) (<-chan message, func()) {
	replies := make(chan message, 1)
	p.mu.Lock()
	p.pending[key] = replies
	p.mu.Unlock()
	return replies, func() {
		p.mu.Lock()
		delete(p.pending, key)
		p.mu.Unlock()
	}
}

func (p *peer) ask(ctx context.Context, msg map[string]any) (message, error) {
	key := fmt.Sprintf("%s-result:%s", msg["type"], msg["id"])
	replies, remove := p.reply(key)
	defer remove()
	if err := p.send(msg); err != nil {
		return message{}, err
	}
	select {
	case <-ctx.Done():
		return message{}, ctx.Err()
	case reply := <-replies:
		if reply.Error != "" {
			return message{}, errors.New(reply.Error)
		}
		return reply, nil
	}
}

func (p *peer) receive(msg message) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if msg.Stream == "" {
		if reply := p.pending[msg.Type+":"+msg.ID]; reply != nil {
			select {
			case reply <- msg:
			default:
				return errors.New("duplicate IPC reply")
			}
		}
		return nil
	}
	if msg.Type == "credit" {
		if credit := p.credits[msg.Stream]; credit != nil {
			select {
			case credit <- struct{}{}:
			default:
				return errors.New("duplicate IPC credit")
			}
		}
		return nil
	}
	if reader := p.readers[msg.Stream]; reader != nil {
		select {
		case <-reader.done:
		case reader.messages <- msg:
		default:
			return errors.New("IPC producer exceeded stream credit")
		}
	}
	return nil
}

func (p *peer) reader(ctx context.Context, id string, trailers http.Header) *bodyReader {
	r := &bodyReader{
		peer: p, id: id, done: ctx.Done(), messages: make(chan message, 1), trailers: trailers,
	}
	p.mu.Lock()
	p.readers[id] = r
	p.mu.Unlock()
	return r
}

func (p *peer) pipe(ctx context.Context, id string, body io.ReadCloser, trailers func() http.Header) error {
	credit := make(chan struct{}, 1)
	p.mu.Lock()
	p.credits[id] = credit
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		delete(p.credits, id)
		p.mu.Unlock()
	}()
	stop := context.AfterFunc(ctx, func() { closeQuietly(body) })
	defer stop()
	defer closeQuietly(body)
	buffer := make([]byte, chunkSize)
	for {
		n, err := body.Read(buffer)
		if n > 0 {
			if sendErr := p.send(message{Type: "chunk", Stream: id, Data: buffer[:n]}); sendErr != nil {
				return sendErr
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-credit:
			}
		}
		if errors.Is(err, io.EOF) {
			values := make(http.Header)
			if trailers != nil {
				values = trailers()
			}
			return p.send(message{Type: "end", Stream: id, Trailers: nodeHeaders(values)})
		}
		if err != nil {
			return fmt.Errorf("read forwarded body: %w", err)
		}
	}
}

func (p *peer) removeStreams(prefix string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for id := range p.readers {
		if strings.HasPrefix(id, prefix) {
			delete(p.readers, id)
		}
	}
}

type bodyReader struct {
	peer     *peer
	id       string
	done     <-chan struct{}
	messages chan message
	buffer   []byte
	trailers http.Header
	eof      bool
}

func (r *bodyReader) Read(buffer []byte) (int, error) {
	if r.eof {
		return 0, io.EOF
	}
	for len(r.buffer) == 0 {
		select {
		case <-r.done:
			return 0, context.Canceled
		case msg := <-r.messages:
			if msg.Type == "end" {
				for name, values := range httpHeaders(msg.Trailers) {
					r.trailers[name] = values
				}
				r.eof = true
				return 0, io.EOF
			}
			r.buffer = msg.Data
			if len(r.buffer) == 0 {
				if err := r.ack(); err != nil {
					return 0, err
				}
			}
		}
	}
	n := copy(buffer, r.buffer)
	r.buffer = r.buffer[n:]
	if len(r.buffer) == 0 {
		if err := r.ack(); err != nil {
			return n, err
		}
	}
	return n, nil
}

func (r *bodyReader) ack() error {
	return r.peer.send(message{Type: "credit", Stream: r.id})
}

func (r *bodyReader) Close() error { return nil }
