package main

import (
	"context"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/adapter/certificate"
	"github.com/sagernet/sing-box/adapter/endpoint"
	"github.com/sagernet/sing-box/adapter/inbound"
	"github.com/sagernet/sing-box/adapter/outbound"
	"github.com/sagernet/sing-box/adapter/service"
	"github.com/sagernet/sing-box/dns"
	"github.com/sagernet/sing-box/dns/transport"
	"github.com/sagernet/sing-box/dns/transport/fakeip"
	"github.com/sagernet/sing-box/dns/transport/local"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing-box/protocol/direct"
	"github.com/sagernet/sing-box/protocol/http"
	"github.com/sagernet/sing-box/protocol/socks"
	"github.com/sagernet/sing-box/protocol/tun"
)

// coreContext deliberately avoids upstream include.Context: its registry imports
// every default protocol, even when optional build tags are disabled.
func coreContext(ctx context.Context) context.Context {
	inbounds := inbound.NewRegistry()
	tun.RegisterInbound(inbounds)
	http.RegisterInbound(inbounds)
	socks.RegisterInbound(inbounds)
	inbound.Register[option.SocksInboundOptions](inbounds, "fluxy-mixed", newProxyInbound)
	direct.RegisterInbound(inbounds)

	outbounds := outbound.NewRegistry()
	direct.RegisterOutbound(outbounds)
	http.RegisterOutbound(outbounds)
	socks.RegisterOutbound(outbounds)
	outbound.Register[inspectOptions](outbounds, "fluxy-inspect", newInspectOutbound)

	transports := dns.NewTransportRegistry()
	local.RegisterTransport(transports)
	fakeip.RegisterTransport(transports)
	transport.RegisterUDP(transports)
	transport.RegisterTCP(transports)
	transport.RegisterTLS(transports)
	transport.RegisterHTTPS(transports)

	return box.Context(ctx, inbounds, outbounds, endpoint.NewRegistry(),
		transports, service.NewRegistry(), certificate.NewRegistry())
}
