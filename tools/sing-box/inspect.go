package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"

	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/adapter/outbound"
	"github.com/sagernet/sing-box/common/dialer"
	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-box/option"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
	sHTTP "github.com/sagernet/sing/protocol/http"
)

// The private CONNECT hop preserves client identity across the sing-box ingress.
// All policy, TLS interception and upstream selection remain in fluxy-proxy.
type inspectOptions struct {
	ServerPort uint16 `json:"server_port"`
	Token      string `json:"token"`
}

type inspectOutbound struct {
	outbound.Adapter
	dialer N.Dialer
	server M.Socksaddr
	token  string
}

func newInspectOutbound(ctx context.Context, _ adapter.Router, _ log.ContextLogger, tag string, options inspectOptions) (adapter.Outbound, error) {
	if options.ServerPort == 0 || len(options.Token) < 32 {
		return nil, errors.New("inspection endpoint requires a port and private token")
	}
	d, err := dialer.New(ctx, option.DialerOptions{}, false)
	if err != nil {
		return nil, err
	}
	return &inspectOutbound{
		Adapter: outbound.NewAdapterWithDialerOptions("fluxy-inspect", tag, []string{N.NetworkTCP}, option.DialerOptions{}),
		dialer:  d,
		server:  M.ParseSocksaddrHostPort("127.0.0.1", options.ServerPort),
		token:   options.Token,
	}, nil
}

func (h *inspectOutbound) DialContext(ctx context.Context, network string, destination M.Socksaddr) (net.Conn, error) {
	if network != N.NetworkTCP {
		return nil, os.ErrInvalid
	}
	metadata := adapter.ContextFrom(ctx)
	if metadata == nil || !metadata.Source.IsValid() {
		return nil, errors.New("inspection connection is missing its source")
	}
	headers := http.Header{
		"X-Fluxy-Token":  []string{h.token},
		"X-Fluxy-Source": []string{metadata.Source.String()},
	}
	if metadata.InboundType == "fluxy-mixed" && metadata.Protocol == "http" {
		headers.Set("X-Fluxy-Protocol", "http")
	}
	client := sHTTP.NewClient(sHTTP.Options{
		Dialer:  h.dialer,
		Server:  h.server,
		Headers: headers,
	})
	return client.DialContext(ctx, network, destination)
}

func (h *inspectOutbound) ListenPacket(context.Context, M.Socksaddr) (net.PacketConn, error) {
	return nil, os.ErrInvalid
}
