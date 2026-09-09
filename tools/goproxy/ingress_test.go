package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestIngressIdentityRequiresAuthenticatedConnect(t *testing.T) {
	for _, source := range []string{"127.0.0.1:32123", "[::1]:32123"} {
		t.Run(source, func(t *testing.T) {
			r := &runtime{ingressToken: "private-token", ingressPort: 6060, port: 45000}
			conn := &trackedConn{}
			r.connections.Store("127.0.0.1:45678", conn)
			req := &http.Request{RemoteAddr: "127.0.0.1:45678", Header: make(http.Header)}
			if r.hasIngress(req) {
				t.Fatal("unauthenticated request accepted")
			}
			for _, token := range []string{"", "wrong", "private-token"} {
				req.Header.Set("X-Fluxy-Source", source)
				req.Header.Set("X-Fluxy-Token", token)
				if got := r.acceptIngress(req); got != (token == "private-token") {
					t.Fatalf("token %q: accepted=%v", token, got)
				}
				if len(req.Header) != 0 {
					t.Fatal("private headers escaped into the capture request")
				}
			}
			if !r.hasIngress(req) {
				t.Fatal("authenticated connection lost its identity")
			}
			metadata := r.socketMetadata(req)
			if metadata["remotePort"] != 32123 || metadata["localPort"] != 6060 {
				t.Fatalf("lost original endpoint: %v", metadata)
			}
		})
	}
}

func TestIngressEnvelopePreservesHTTPStream(t *testing.T) {
	r := &runtime{ingressToken: "private-token", ingressPort: 6060}
	server, client := net.Pipe()
	defer closeQuietly(server)
	defer closeQuietly(client)
	r.connections.Store(server.RemoteAddr().String(), &trackedConn{})
	payload := "POST http://example.com/upload HTTP/1.1\r\nHost: example.com\r\nContent-Length: 16000\r\n\r\n" + strings.Repeat("x", 16000)
	done := make(chan error, 1)
	go func() {
		_ = client.SetDeadline(time.Now().Add(5 * time.Second))
		_, err := fmt.Fprint(client, "CONNECT http.fluxy.invalid:80 HTTP/1.1\r\nHost: http.fluxy.invalid:80\r\nX-Fluxy-Token: private-token\r\nX-Fluxy-Source: 127.0.0.1:32123\r\nX-Fluxy-Protocol: http\r\n\r\n")
		if err == nil {
			var response *http.Response
			response, err = http.ReadResponse(bufio.NewReader(client), &http.Request{Method: "CONNECT"})
			if err == nil && response.StatusCode != 200 {
				err = fmt.Errorf("status: %d", response.StatusCode)
			}
		}
		if err == nil {
			_, err = io.WriteString(client, payload)
		}
		_ = client.Close()
		done <- err
	}()
	prepared, err := r.prepareIngress(server)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(prepared)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != payload {
		t.Fatalf("application stream changed: received %d bytes", len(data))
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestIngressRejectsMalformedSource(t *testing.T) {
	r := &runtime{ingressToken: "private-token"}
	r.connections.Store("peer", &trackedConn{})
	for _, source := range []string{"", "localhost:123", "127.0.0.1:0", "127.0.0.1:99999"} {
		req := &http.Request{RemoteAddr: "peer", Header: make(http.Header)}
		req.Header.Set("X-Fluxy-Token", r.ingressToken)
		req.Header.Set("X-Fluxy-Source", source)
		if r.acceptIngress(req) || r.hasIngress(req) {
			t.Fatalf("invalid source accepted: %q", source)
		}
	}
}
