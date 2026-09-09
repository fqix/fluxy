package main

import (
	"context"
	"io"
	"net"
	"time"

	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/adapter/inbound"
	"github.com/sagernet/sing-box/common/listener"
	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing-box/protocol/socks"
	"github.com/sagernet/sing/common"
	"github.com/sagernet/sing/common/buf"
	"github.com/sagernet/sing/common/bufio"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
)

// SOCKS is handled by sing-box. HTTP is transported intact to the inspector:
// a second HTTP proxy would normalize Upgrade/streaming and cancellation.
type proxyInbound struct {
	inbound.Adapter
	listener *listener.Listener
	socks    adapter.TCPInjectableInbound
	router   adapter.Router
}

func newProxyInbound(ctx context.Context, router adapter.Router, logger log.ContextLogger, tag string, options option.SocksInboundOptions) (adapter.Inbound, error) {
	socksInbound, err := socks.NewInbound(ctx, router, logger, tag, options)
	if err != nil {
		return nil, err
	}
	h := &proxyInbound{
		Adapter: inbound.NewAdapter("fluxy-mixed", tag),
		socks:   socksInbound.(adapter.TCPInjectableInbound), router: router,
	}
	h.listener = listener.New(listener.Options{
		Context: ctx, Logger: logger, Network: []string{N.NetworkTCP},
		Listen: options.ListenOptions, ConnectionHandler: h,
	})
	return h, nil
}

func (h *proxyInbound) Start(stage adapter.StartStage) error {
	if stage == adapter.StartStateStart {
		return h.listener.Start()
	}
	return nil
}

func (h *proxyInbound) Close() error { return common.Close(h.listener, h.socks) }

func (h *proxyInbound) NewConnection(ctx context.Context, conn net.Conn, metadata adapter.InboundContext, onClose N.CloseHandlerFunc) {
	if err := conn.SetReadDeadline(time.Now().Add(15 * time.Second)); err != nil {
		N.CloseOnHandshakeFailure(conn, onClose, err)
		return
	}
	var first [1]byte
	if _, err := io.ReadFull(conn, first[:]); err != nil {
		N.CloseOnHandshakeFailure(conn, onClose, err)
		return
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		N.CloseOnHandshakeFailure(conn, onClose, err)
		return
	}
	conn = bufio.NewCachedConn(conn, buf.As(first[:]))
	if first[0] == 4 || first[0] == 5 {
		h.socks.NewConnection(ctx, conn, metadata, onClose)
		return
	}
	metadata.Inbound = h.Tag()
	metadata.InboundType = h.Type()
	metadata.Protocol = "http"
	// Only the private inspection outbound handles this marker. It never resolves
	// or dials it: the original HTTP request retains the actual destination.
	metadata.Destination = M.ParseSocksaddr("http.fluxy.invalid:80")
	h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
