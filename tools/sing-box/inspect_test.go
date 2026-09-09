package main

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/adapter/outbound"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
)

// Test the actual CONNECT wire: it must carry the original source separately
// from its destination, with no DNS lookup for the destination at the ingress.
func TestInspectPreservesSource(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	received := make(chan *http.Request, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		req, err := http.ReadRequest(bufio.NewReader(conn))
		if err != nil {
			return
		}
		received <- req
		_, _ = fmt.Fprint(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ctx = adapter.WithContext(ctx, &adapter.InboundContext{Source: M.ParseSocksaddr("127.0.0.1:32123")})
	bridge := &inspectOutbound{
		Adapter: outbound.NewAdapter("fluxy-inspect", "inspect", []string{N.NetworkTCP}, nil),
		dialer:  testDialer{}, server: M.SocksaddrFromNet(listener.Addr()), token: "private-token",
	}
	conn, err := bridge.DialContext(ctx, N.NetworkTCP, M.ParseSocksaddr("unresolved.invalid:443"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	select {
	case req := <-received:
		if req.Method != "CONNECT" || req.Host != "unresolved.invalid:443" ||
			req.Header.Get("X-Fluxy-Source") != "127.0.0.1:32123" ||
			req.Header.Get("X-Fluxy-Token") != "private-token" {
			t.Fatalf("incorrect inspection request: %#v", req)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

type testDialer struct{}

func (testDialer) DialContext(ctx context.Context, network string, address M.Socksaddr) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, network, address.String())
}
func (testDialer) ListenPacket(context.Context, M.Socksaddr) (net.PacketConn, error) {
	return nil, net.ErrClosed
}
