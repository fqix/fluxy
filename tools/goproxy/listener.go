package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type mixedListener struct {
	net.Listener
	ready       chan net.Conn
	done        <-chan struct{}
	cancel      context.CancelFunc
	connections *sync.Map
	workers     sync.WaitGroup
}

func newMixedListener(ctx context.Context, listener net.Listener, connections *sync.Map) *mixedListener {
	ctx, cancel := context.WithCancel(ctx)
	l := &mixedListener{Listener: listener, ready: make(chan net.Conn), done: ctx.Done(), cancel: cancel, connections: connections}
	l.workers.Go(func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				cancel()
				return
			}
			connectionCtx, connectionCancel := context.WithCancel(ctx)
			tracked := &trackedConn{
				Conn: conn, ctx: connectionCtx, cancel: connectionCancel, connections: connections,
				incoming: make(chan connectionRead, 1), readWake: make(chan struct{}, 1),
			}
			l.workers.Go(tracked.pump)
			connections.Store(conn.RemoteAddr().String(), tracked)
			l.workers.Go(func() {
				prepared, err := prepareMixed(tracked)
				if err != nil {
					closeQuietly(tracked)
					return
				}
				select {
				case <-ctx.Done():
					closeQuietly(tracked)
				case l.ready <- prepared:
				}
			})
		}
	})
	return l
}

func (l *mixedListener) Accept() (net.Conn, error) {
	select {
	case <-l.done:
		return nil, net.ErrClosed
	case conn := <-l.ready:
		return conn, nil
	}
}

func (l *mixedListener) Close() error {
	l.cancel()
	err := l.Listener.Close()
	l.connections.Range(func(_ any, value any) bool { closeQuietly(value.(net.Conn)); return true })
	l.workers.Wait()
	return err
}

type trackedConn struct {
	net.Conn
	// This context belongs to the connection lifetime, including hijacked MITM
	// requests whose library-created request contexts do not inherit ConnContext.
	ctx                context.Context
	cancel             context.CancelFunc
	connections        *sync.Map
	once               sync.Once
	incoming           chan connectionRead
	buffer             []byte
	readErr            error
	deadlineMu         sync.Mutex
	deadline           time.Time
	readWake           chan struct{}
	closeAfterResponse atomic.Bool
}

type connectionRead struct {
	data []byte
	err  error
}

// One read ahead detects a closed TLS client even while goproxy is waiting at
// response headers or in an indefinite SSE body. The single slot bounds memory
// and retains pipelined requests for the normal HTTP parser.
func (c *trackedConn) pump() {
	for {
		data := make([]byte, chunkSize)
		n, err := c.Conn.Read(data)
		var networkError net.Error
		timeout := errors.As(err, &networkError) && networkError.Timeout()
		if err != nil && !timeout {
			c.cancel()
			return
		}
		select {
		case <-c.ctx.Done():
			return
		case c.incoming <- connectionRead{data: data[:n], err: err}:
		}
		if timeout {
			for {
				c.deadlineMu.Lock()
				deadline := c.deadline
				c.deadlineMu.Unlock()
				if deadline.IsZero() || deadline.After(time.Now()) {
					break
				}
				select {
				case <-c.ctx.Done():
					return
				case <-c.readWake:
				}
			}
		}
	}
}

func (c *trackedConn) Read(data []byte) (int, error) {
	if c.closeAfterResponse.Load() {
		closeQuietly(c)
		return 0, io.EOF
	}
	if len(c.buffer) == 0 && c.readErr == nil {
		select {
		case <-c.ctx.Done():
			return 0, net.ErrClosed
		case result := <-c.incoming:
			c.buffer, c.readErr = result.data, result.err
		}
	}
	n := copy(data, c.buffer)
	c.buffer = c.buffer[n:]
	if len(c.buffer) == 0 {
		err := c.readErr
		c.readErr = nil
		return n, err
	}
	return n, nil
}
func (c *trackedConn) SetReadDeadline(deadline time.Time) error {
	c.deadlineMu.Lock()
	defer c.deadlineMu.Unlock()
	// Publish a reset only after the socket has accepted it. Otherwise the
	// pump can retry against the expired deadline and queue a stale timeout.
	if err := c.Conn.SetReadDeadline(deadline); err != nil {
		return err
	}
	c.deadline = deadline
	select {
	case c.readWake <- struct{}{}:
	default:
	}
	return nil
}
func (c *trackedConn) SetDeadline(deadline time.Time) error {
	if err := c.SetReadDeadline(deadline); err != nil {
		return err
	}
	return c.SetWriteDeadline(deadline)
}
func (c *trackedConn) Close() error {
	c.once.Do(func() { c.cancel(); c.connections.Delete(c.RemoteAddr().String()) })
	return c.Conn.Close()
}

type bufferedConn struct {
	net.Conn
	reader io.Reader
}

func (c *bufferedConn) Read(data []byte) (int, error) { return c.reader.Read(data) }

func prepareMixed(conn net.Conn) (net.Conn, error) {
	if err := conn.SetReadDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return nil, err
	}
	reader := bufio.NewReader(conn)
	first, err := reader.Peek(1)
	if err != nil {
		return nil, err
	}
	if first[0] != 5 {
		if err := conn.SetReadDeadline(time.Time{}); err != nil {
			return nil, err
		}
		return &bufferedConn{Conn: conn, reader: reader}, nil
	}
	target, err := socksHandshake(reader, conn)
	if err != nil {
		return nil, err
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		return nil, err
	}
	// Reuse the same CONNECT policy and MITM path without a second local hop.
	request := "CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n\r\n"
	return &socksConn{bufferedConn: bufferedConn{Conn: conn, reader: io.MultiReader(strings.NewReader(request), reader)}}, nil
}

func socksHandshake(reader io.Reader, writer io.Writer) (string, error) {
	var greeting [2]byte
	if _, err := io.ReadFull(reader, greeting[:]); err != nil {
		return "", err
	}
	methods := make([]byte, int(greeting[1]))
	if _, err := io.ReadFull(reader, methods); err != nil {
		return "", err
	}
	if greeting[0] != 5 || !bytes.Contains(methods, []byte{0}) {
		if _, err := writer.Write([]byte{5, 255}); err != nil {
			return "", err
		}
		return "", errors.New("SOCKS5 no-auth method required")
	}
	if _, err := writer.Write([]byte{5, 0}); err != nil {
		return "", err
	}
	var head [4]byte
	if _, err := io.ReadFull(reader, head[:]); err != nil {
		return "", err
	}
	if head[0] != 5 || head[1] != 1 || head[2] != 0 {
		if _, err := writer.Write([]byte{5, 7, 0, 1, 0, 0, 0, 0, 0, 0}); err != nil {
			return "", err
		}
		return "", errors.New("only SOCKS5 CONNECT is supported")
	}
	size := 0
	switch head[3] {
	case 1:
		size = 4
	case 4:
		size = 16
	case 3:
		var length [1]byte
		if _, err := io.ReadFull(reader, length[:]); err != nil {
			return "", err
		}
		size = int(length[0])
	default:
		return "", errors.New("unsupported SOCKS5 address type")
	}
	address := make([]byte, size)
	if _, err := io.ReadFull(reader, address); err != nil {
		return "", err
	}
	host := string(address)
	if head[3] != 3 {
		host = net.IP(address).String()
	}
	if host == "" || strings.ContainsAny(host, "\r\n\x00 /\\") {
		return "", errors.New("invalid SOCKS5 host")
	}
	var port [2]byte
	if _, err := io.ReadFull(reader, port[:]); err != nil {
		return "", err
	}
	return net.JoinHostPort(host, strconv.Itoa(int(binary.BigEndian.Uint16(port[:])))), nil
}

type socksConn struct {
	bufferedConn
	head        []byte
	established bool
}

func (c *socksConn) Write(data []byte) (int, error) {
	if c.established {
		return c.Conn.Write(data)
	}
	n := len(data)
	c.head = append(c.head, data...)
	end := bytes.Index(c.head, []byte("\r\n\r\n"))
	if end < 0 {
		if len(c.head) > 8192 {
			return 0, errors.New("CONNECT response header too large")
		}
		return n, nil
	}
	success := bytes.HasPrefix(c.head, []byte("HTTP/1.1 200 "))
	code := byte(1)
	if success {
		code = 0
	}
	if _, err := c.Conn.Write([]byte{5, code, 0, 1, 0, 0, 0, 0, 0, 0}); err != nil {
		return 0, err
	}
	if !success {
		return 0, errors.New("SOCKS5 target connection rejected")
	}
	c.established = true
	rest := c.head[end+4:]
	c.head = nil
	if len(rest) > 0 {
		if _, err := c.Conn.Write(rest); err != nil {
			return 0, err
		}
	}
	return n, nil
}

func connectHTTPProxy(ctx context.Context, transport *http.Transport, target string) (net.Conn, error) {
	proxyURL, err := transport.Proxy(&http.Request{URL: &url.URL{Scheme: "http", Host: target}})
	if err != nil {
		return nil, err
	}
	address := proxyURL.Host
	if proxyURL.Port() == "" {
		port := "80"
		if proxyURL.Scheme == "https" {
			port = "443"
		}
		address = net.JoinHostPort(proxyURL.Hostname(), port)
	}
	conn, err := transport.DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			closeQuietly(conn)
		}
	}()
	stop := context.AfterFunc(ctx, func() { closeQuietly(conn) })
	defer stop()
	if err := conn.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return nil, err
	}
	if proxyURL.Scheme == "https" {
		config := transport.TLSClientConfig.Clone()
		config.ServerName = proxyURL.Hostname()
		secure := tls.Client(conn, config)
		if err := secure.HandshakeContext(ctx); err != nil {
			return nil, err
		}
		conn = secure
	}
	req := &http.Request{Method: http.MethodConnect, URL: &url.URL{Opaque: target}, Host: target, Header: make(http.Header)}
	if proxyURL.User != nil {
		password, _ := proxyURL.User.Password()
		req.SetBasicAuth(proxyURL.User.Username(), password)
		req.Header.Set("Proxy-Authorization", req.Header.Get("Authorization"))
		req.Header.Del("Authorization")
	}
	if err := req.Write(conn); err != nil {
		return nil, err
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, req)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upstream CONNECT returned %d", response.StatusCode)
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	ok = true
	return &bufferedConn{Conn: conn, reader: reader}, nil
}
