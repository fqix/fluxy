package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/elazarl/goproxy"
)

type exchange struct {
	session *session
	timing  *requestTiming
}

func (r *runtime) proxy(root identity) (*goproxy.ProxyHttpServer, error) {
	ca, err := tls.X509KeyPair([]byte(root.Certificate), []byte(root.Key))
	if err != nil {
		return nil, fmt.Errorf("load interception CA: %w", err)
	}
	proxy := goproxy.NewProxyHttpServer()
	proxy.AllowHTTP2 = true
	proxy.KeepAcceptEncoding = true
	proxy.NonproxyHandler = http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		req.URL.Scheme = "http"
		req.URL.Host = req.Host
		proxy.ServeHTTP(w, req)
	})
	// Never use goproxy's default insecure transport or environment proxy.
	proxy.Tr = &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	proxy.ConnectDial = nil
	proxy.CertStore = &certificateCache{certificates: make(map[string]*tls.Certificate)}
	baseTLS := goproxy.TLSConfigFromCA(&ca)
	mitm := &goproxy.ConnectAction{
		Action: goproxy.ConnectMitm,
		TLSConfig: func(host string, pc *goproxy.ProxyCtx) (*tls.Config, error) {
			ctx := r.connectionContext(pc.Req)
			certificateHost := host
			if name, _, err := net.SplitHostPort(host); err == nil {
				certificateHost = name
			}
			result, err := r.peer.ask(ctx, map[string]any{
				"type": "certificate", "id": fmt.Sprint(r.sequence.Add(1)), "host": certificateHost,
			})
			if err != nil {
				return nil, err
			}
			if result.Identity != nil {
				cert, err := tls.X509KeyPair([]byte(result.Identity.Certificate), []byte(result.Identity.Key))
				if err != nil {
					return nil, fmt.Errorf("load server identity: %w", err)
				}
				return &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}, nil
			}
			config, err := baseTLS(host, pc)
			if config != nil {
				config.InsecureSkipVerify = false
				config.MinVersion = tls.VersionTLS12
			}
			return config, err
		},
	}
	proxy.OnRequest().HandleConnectFunc(func(host string, pc *goproxy.ProxyCtx) (*goproxy.ConnectAction, string) {
		if !r.hasIngress(pc.Req) {
			return goproxy.RejectConnect, host
		}
		ctx, session := r.session(r.connectionContext(pc.Req))
		out := r.peer.reader(ctx, session.id+":tunnel:out", make(http.Header))
		replies, remove := r.peer.reply("inspect:" + session.id)
		defer remove()
		if err := r.peer.send(map[string]any{
			"type": "connect", "id": session.id, "request": requestMetadata(pc.Req), "socket": r.socketMetadata(pc.Req),
		}); err != nil {
			session.finish(false, err)
			return goproxy.RejectConnect, host
		}
		select {
		case <-ctx.Done():
			return goproxy.RejectConnect, host
		case result := <-replies:
			session.finish(true, nil)
			if result.Error != "" {
				return goproxy.RejectConnect, host
			}
			return mitm, host
		case first := <-out.messages:
			out.messages <- first
			return &goproxy.ConnectAction{
				Action: goproxy.ConnectHijack,
				Hijack: func(_ *http.Request, client net.Conn, _ *goproxy.ProxyCtx) {
					defer closeQuietly(client)
					stop := context.AfterFunc(ctx, func() { closeQuietly(client) })
					defer stop()
					session.workers.Go(func() {
						err := r.peer.pipe(ctx, session.id+":tunnel:in", client, nil)
						if err != nil {
							session.finish(false, err)
						}
					})
					_, err := io.Copy(client, out)
					session.finish(err == nil, err)
				},
			}, host
		}
	})
	proxy.OnRequest().DoFunc(r.onRequest)
	proxy.OnResponse().DoFunc(r.onResponse)
	return proxy, nil
}

func (r *runtime) onRequest(req *http.Request, pc *goproxy.ProxyCtx) (*http.Request, *http.Response) {
	if !r.hasIngress(req) {
		return req, goproxy.NewResponse(req, "text/plain", http.StatusProxyAuthRequired, "Private inspection endpoint")
	}
	originalRequest := req
	ctx, session := r.session(req.Context())
	stopConnection := context.AfterFunc(r.connectionContext(req), session.disconnected)
	context.AfterFunc(ctx, func() { stopConnection() })
	ex := &exchange{session: session, timing: newTiming(time.Now())}
	pc.UserData = ex
	req = req.WithContext(ctx)
	if isWebSocket(req.Header) {
		return r.websocketRequest(req, pc, ex)
	}
	output := r.peer.reader(ctx, session.id+":request:out", make(http.Header))
	result, err := session.askBody(ctx, map[string]any{
		"type": "request", "request": requestMetadata(req), "socket": r.socketMetadata(req),
	}, req.Body, func() http.Header { return originalRequest.Trailer })
	if err != nil {
		return req, failedResponse(req, session, err)
	}
	if result.Local {
		session.local = true
		return req, localResponse(req, result, output, session)
	}
	target, err := url.Parse(result.URL)
	if err != nil {
		return req, failedResponse(req, session, err)
	}
	req.URL = target
	req.Method = result.Options.Method
	req.Header = httpHeaders(result.Options.Headers)
	req.Host = req.Header.Get("Host")
	if req.Host == "" {
		req.Host = target.Host
	}
	req.Header.Del("Host")
	req.RequestURI = ""
	req.Body = output
	req.Trailer = output.trailers
	req.ContentLength = contentLength(req.Header)
	req.TransferEncoding = nil
	if req.ContentLength == 0 {
		req.Body = http.NoBody
		session.workers.Go(func() {
			if _, err := io.Copy(io.Discard, output); err != nil {
				session.finish(false, err)
			}
		})
	}
	r.setRoundTripper(pc, result.Options, result.Route, ex, false)
	return req, nil
}

func (r *runtime) setRoundTripper(pc *goproxy.ProxyCtx, options requestOptions, route string, ex *exchange, websocket bool) {
	pc.RoundTripper = goproxy.RoundTripperFunc(func(req *http.Request, _ *goproxy.ProxyCtx) (*http.Response, error) {
		h2c := req.URL.Scheme == "http" && (req.ProtoMajor == 2 || strings.HasPrefix(req.Header.Get("Content-Type"), "application/grpc"))
		transport, err := r.transports.get(options, route, h2c, websocket)
		if err != nil {
			return failedResponse(req, ex.session, err), nil
		}
		traced := req.WithContext(httptrace.WithClientTrace(req.Context(), ex.timing.trace()))
		response, err := transport.RoundTrip(traced)
		if err != nil {
			return failedResponse(req, ex.session, err), nil
		}
		// Keep this object's identity across the response hook. goproxy otherwise
		// removes Content-Length even for unchanged/HEAD bodies when it sees a wrapper.
		response.Body = &forwardBody{body: response.Body}
		return response, nil
	})
}

func (r *runtime) onResponse(resp *http.Response, pc *goproxy.ProxyCtx) *http.Response {
	ex, ok := pc.UserData.(*exchange)
	if !ok || ex.session.local {
		return resp
	}
	session := ex.session
	select {
	case <-session.done:
		return resp
	default:
	}
	if session.websocket {
		return r.websocketResponse(resp, pc, ex)
	}
	if resp == nil {
		return failedResponse(pc.Req, session, errors.New("upstream returned no response"))
	}
	body, ok := resp.Body.(*forwardBody)
	if !ok {
		return failedResponse(pc.Req, session, errors.New("missing upstream body"))
	}
	ctx := pc.Req.Context()
	// The filtered request carries the cancellation context; goproxy may retain
	// its original Req pointer, so combine the body streams with session lifetime.
	ctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	session.workers.Go(func() { <-session.done; cancel() })
	trailers := make(http.Header)
	for name := range resp.Trailer {
		trailers[name] = nil
	}
	// Snapshot before the producer starts: HTTP/2 assigns upstream trailers
	// during Body.Read, so copying the whole response after that would race.
	clientResponse := *resp
	output := r.peer.reader(ctx, session.id+":response:out", trailers)
	result, err := session.askBody(ctx, map[string]any{
		"type": "response", "response": responseMetadata(resp), "timings": ex.timing.snapshot(),
	}, body.body, func() http.Header { return resp.Trailer })
	if err != nil {
		return failedResponse(pc.Req, session, err)
	}
	if result.Local {
		return localResponse(pc.Req, result, output, session)
	}
	// The upstream transport may assign its Trailer map only at EOF. Keep that
	// response separate from the client response while the producer is reading it.
	clientResponse.StatusCode = result.Status
	clientResponse.Status = fmt.Sprintf("%d %s", result.Status, http.StatusText(result.Status))
	clientResponse.Header = httpHeaders(result.Headers)
	clientResponse.ContentLength = contentLength(clientResponse.Header)
	clientResponse.Trailer = trailers
	body.body = output
	body.expected = clientResponse.ContentLength
	body.session = session
	body.finish = func() {
		session.finish(output.eof, nil)
		if pc.Req.Close {
			if value, ok := r.connections.Load(pc.Req.RemoteAddr); ok {
				// Response.Write closes its Body before it writes final chunk framing.
				// Close when the MITM parser asks for another request instead.
				value.(*trackedConn).closeAfterResponse.Store(true)
			}
		}
	}
	return &clientResponse
}

type forwardBody struct {
	body     io.ReadCloser
	finish   func()
	once     sync.Once
	session  *session
	expected int64
	read     int64
}

func (b *forwardBody) Read(data []byte) (int, error) {
	n, err := b.body.Read(data)
	b.read += int64(n)
	if b.session != nil && b.expected >= 0 && b.read == b.expected {
		b.session.delivered.Store(true)
	}
	return n, err
}
func (b *forwardBody) Close() error {
	err := b.body.Close()
	b.once.Do(func() {
		if b.finish != nil {
			b.finish()
		}
	})
	return err
}

func localResponse(req *http.Request, result message, output *bodyReader, session *session) *http.Response {
	return &http.Response{
		StatusCode: result.Status, Status: fmt.Sprintf("%d %s", result.Status, http.StatusText(result.Status)),
		Header: httpHeaders(result.Headers), ContentLength: contentLength(httpHeaders(result.Headers)),
		Body:    &forwardBody{body: output, finish: func() { session.finish(output.eof, nil) }},
		Request: req, Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
	}
}

func failedResponse(req *http.Request, session *session, err error) *http.Response {
	session.finish(false, err)
	return goproxy.NewResponse(req, "text/plain", http.StatusBadGateway, "Proxy connection failed")
}

func requestMetadata(req *http.Request) map[string]any {
	headers := req.Header.Clone()
	headers.Set("Host", req.Host)
	target := req.URL.String()
	if req.Method == http.MethodConnect {
		target = req.Host
	}
	return map[string]any{
		"headers": nodeHeaders(headers), "rawHeaders": rawHeaders(headers),
		"method": req.Method, "url": target, "httpVersion": fmt.Sprintf("%d.%d", req.ProtoMajor, req.ProtoMinor),
	}
}

func responseMetadata(resp *http.Response) map[string]any {
	return map[string]any{
		"headers": nodeHeaders(resp.Header), "rawHeaders": rawHeaders(resp.Header),
		"statusCode": resp.StatusCode, "statusMessage": http.StatusText(resp.StatusCode),
		"httpVersion": fmt.Sprintf("%d.%d", resp.ProtoMajor, resp.ProtoMinor),
	}
}

func rawHeaders(headers http.Header) []string {
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	result := []string{}
	for _, name := range names {
		for _, value := range headers[name] {
			result = append(result, name, value)
		}
	}
	return result
}

func contentLength(headers http.Header) int64 {
	length, err := strconv.ParseInt(headers.Get("Content-Length"), 10, 64)
	if err != nil || length < 0 {
		return -1
	}
	return length
}

func (r *runtime) socketMetadata(req *http.Request) map[string]any {
	if value, ok := r.connections.Load(req.RemoteAddr); ok {
		if source := value.(*trackedConn).ingressSource.Load(); source != nil {
			return map[string]any{"remoteAddress": source.IP.String(), "remotePort": source.Port, "localPort": r.ingressPort, "localAddress": "127.0.0.1"}
		}
	}
	host, port, _ := net.SplitHostPort(req.RemoteAddr)
	number, _ := strconv.Atoi(port)
	return map[string]any{"remoteAddress": host, "remotePort": number, "localPort": r.port, "localAddress": "127.0.0.1"}
}

func (r *runtime) connectionContext(req *http.Request) context.Context {
	if value, ok := r.connections.Load(req.RemoteAddr); ok {
		return value.(*trackedConn).ctx
	}
	return req.Context()
}

type certificateCache struct {
	mu           sync.Mutex
	certificates map[string]*tls.Certificate
}

func (c *certificateCache) Fetch(host string, generate func() (*tls.Certificate, error)) (*tls.Certificate, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if cert := c.certificates[host]; cert != nil {
		return cert, nil
	}
	cert, err := generate()
	if err != nil {
		return nil, err
	}
	if len(c.certificates) >= 512 {
		clear(c.certificates)
	}
	c.certificates[host] = cert
	return cert, nil
}

// Flush streamed responses even when the library sees canonicalized header keys.
type flushHandler struct{ http.Handler }

func (h flushHandler) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	response := &flushingResponse{ResponseWriter: w}
	defer func() {
		// CONNECT MITM continues in the library's background loop. Direct WS
		// forwarding runs until completion here and must close its hijacked socket.
		if req.Method != http.MethodConnect && response.hijacked != nil {
			closeQuietly(response.hijacked)
		}
	}()
	h.Handler.ServeHTTP(response, req)
}

type flushingResponse struct {
	http.ResponseWriter
	hijacked net.Conn
}

func (w *flushingResponse) Write(data []byte) (int, error) {
	n, err := w.ResponseWriter.Write(data)
	if err == nil {
		err = http.NewResponseController(w.ResponseWriter).Flush()
	}
	return n, err
}
func (w *flushingResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *flushingResponse) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, buffered, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err != nil {
		return nil, nil, err
	}
	// A direct WebSocket upgrade writes 101 before hijacking. Flush the HTTP
	// server's buffered handshake before the frame relay takes over the socket.
	if err := buffered.Flush(); err != nil {
		closeQuietly(conn)
		return nil, nil, err
	}
	if buffered.Reader.Buffered() > 0 {
		conn = &bufferedConn{Conn: conn, reader: buffered.Reader}
	}
	w.hijacked = conn
	return conn, buffered, nil
}
