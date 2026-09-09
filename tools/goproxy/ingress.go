package main

import (
	"bufio"
	"bytes"
	"crypto/subtle"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"time"
)

func (r *runtime) prepareIngress(conn net.Conn) (net.Conn, error) {
	if err := conn.SetReadDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return nil, err
	}
	// Limit the private envelope, without limiting the application stream after it.
	reader := bufio.NewReader(io.LimitReader(conn, 8192))
	req, err := http.ReadRequest(reader)
	if err != nil {
		return nil, err
	}
	req.RemoteAddr = conn.RemoteAddr().String()
	if req.Method != http.MethodConnect || req.ContentLength != 0 || !r.acceptIngress(req) {
		return nil, errors.New("unauthorized inspection connection")
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		return nil, err
	}
	stream := io.MultiReader(reader, conn)
	rawHTTP := req.Header.Get("X-Fluxy-Protocol") == "http"
	req.Header.Del("X-Fluxy-Protocol")
	if rawHTTP {
		if _, err := io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
			return nil, err
		}
		return &bufferedConn{Conn: conn, reader: stream}, nil
	}
	// SOCKS destinations enter the existing CONNECT inspection path. The private
	// envelope's credentials are already removed before any capture hooks run.
	var request bytes.Buffer
	if err := req.Write(&request); err != nil {
		return nil, err
	}
	return &bufferedConn{Conn: conn, reader: io.MultiReader(&request, stream)}, nil
}

// Only the authenticated internal CONNECT may set connection identity. Remove
// private headers before publishing the request or forwarding application data.
func (r *runtime) acceptIngress(req *http.Request) bool {
	token := req.Header.Get("X-Fluxy-Token")
	source := req.Header.Get("X-Fluxy-Source")
	req.Header.Del("X-Fluxy-Token")
	req.Header.Del("X-Fluxy-Source")
	if r.ingressToken == "" {
		return true
	}
	if subtle.ConstantTimeCompare([]byte(token), []byte(r.ingressToken)) != 1 {
		return false
	}
	addr, err := netip.ParseAddrPort(source)
	if err != nil || addr.Port() == 0 {
		return false
	}
	value, ok := r.connections.Load(req.RemoteAddr)
	if !ok {
		return false
	}
	value.(*trackedConn).ingressSource.Store(net.TCPAddrFromAddrPort(addr))
	return true
}

func (r *runtime) hasIngress(req *http.Request) bool {
	if r.ingressToken == "" {
		return true
	}
	value, ok := r.connections.Load(req.RemoteAddr)
	return ok && value.(*trackedConn).ingressSource.Load() != nil
}
