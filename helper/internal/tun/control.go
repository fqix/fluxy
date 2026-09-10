package tun

import (
	"crypto/subtle"
	"io"
	"net"
	"sync"
	"time"
)

// inspectorControl relays the authenticated desktop stream to the owned core's
// stdin/stdout. Closing either side ends the core's IPC lease.
type inspectorControl struct {
	listener *net.TCPListener
	input    io.WriteCloser
	output   io.ReadCloser
	mu       sync.Mutex
	peer     net.Conn
	closed   bool
	done     chan struct{}
}

func newInspectorControl(input io.WriteCloser, output io.ReadCloser, token string) (*inspectorControl, error) {
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return nil, err
	}
	c := &inspectorControl{listener: listener, input: input, output: output, done: make(chan struct{})}
	_ = listener.SetDeadline(time.Now().Add(20 * time.Second))
	go c.serve(token)
	return c, nil
}
func (c *inspectorControl) port() int { return c.listener.Addr().(*net.TCPAddr).Port }
func (c *inspectorControl) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	c.listener.Close()
	if c.peer != nil {
		c.peer.Close()
	}
	c.input.Close()
	c.output.Close()
}
func (c *inspectorControl) serve(token string) {
	defer close(c.done)
	defer c.close()
	for {
		conn, err := c.listener.AcceptTCP()
		if err != nil {
			return
		}
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			conn.Close()
			return
		}
		c.peer = conn
		c.mu.Unlock()
		_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
		auth := make([]byte, len(token)+1)
		_, err = io.ReadFull(conn, auth)
		if err != nil || subtle.ConstantTimeCompare(auth, []byte(token+"\n")) != 1 {
			conn.Close()
			continue
		}
		c.listener.Close()
		if _, err = io.WriteString(conn, "OK\n"); err != nil {
			return
		}
		_ = conn.SetDeadline(time.Time{})
		copied := make(chan struct{})
		go func() { defer close(copied); io.Copy(conn, c.output); c.close() }()
		io.Copy(c.input, conn)
		c.close()
		<-copied
		return
	}
}
