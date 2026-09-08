package main

import (
	"runtime"
	"testing"
)

func TestSplitDNSValidation(t *testing.T) {
	p := tunParams{BridgePort: 6060, EgressPort: 6061, Password: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		InterfaceName: "utun2345", SplitDNS: &splitDNSParams{IPv4Range: "198.19.0.0/16", Server: "192.168.1.1"}}
	if runtime.GOOS != "darwin" {
		if p.SplitDNS.validate() == nil {
			t.Fatal("accepted unsupported platform")
		}
		return
	}
	if err := p.validate(); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name   string
		change func(*tunParams)
	}{
		{"default route", func(p *tunParams) { p.SplitDNS.IPv4Range = "0.0.0.0/0" }},
		{"DNS loop", func(p *tunParams) { p.SplitDNS.Server = splitDNSAddress }},
		{"fake IPv4 loop", func(p *tunParams) { p.SplitDNS.Server = "198.19.1.1" }},
		{"fake IPv6 loop", func(p *tunParams) { p.SplitDNS.Server = "fd7a:115c:a1e0::2" }},
		{"server injection", func(p *tunParams) { p.SplitDNS.Server = "127.0.0.1\nremove other" }},
		{"SOCKS override", func(p *tunParams) { p.SocksPort = 7897 }},
		{"route override", func(p *tunParams) { p.RouteCIDRs = []string{"0.0.0.0/0"} }},
		{"interface override", func(p *tunParams) { p.EgressInterface = "en0" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			next := p
			dns := *p.SplitDNS
			next.SplitDNS = &dns
			test.change(&next)
			if next.validate() == nil {
				t.Fatal("accepted unsafe split DNS profile")
			}
		})
	}
}

func TestSplitDNSConfig(t *testing.T) {
	p := validParams()
	p.SocksPort = 0
	p.RouteCIDRs = nil
	p.SplitDNS = &splitDNSParams{IPv4Range: "198.19.0.0/16", Server: "192.168.1.1"}
	c := config(p)
	inbound := c["inbounds"].([]any)[0].(map[string]any)
	routes := inbound["route_address"].([]string)
	if len(routes) != 3 || routes[0] != p.SplitDNS.IPv4Range || routes[1] != fakeIPv6Range || routes[2] != splitDNSAddress+"/32" {
		t.Fatalf("unexpected capture routes: %v", routes)
	}
	outbound := c["outbounds"].([]any)[0].(map[string]any)
	if _, bound := outbound["bind_interface"]; bound || outbound["type"] != "direct" {
		t.Fatal("real egress does not follow existing routes")
	}
	dns := c["dns"].(map[string]any)
	if dns["servers"].([]any)[0].(map[string]any)["server"] != p.SplitDNS.Server {
		t.Fatal("lost original upstream DNS")
	}
	if c["route"].(map[string]any)["rules"].([]any)[1].(map[string]any)["action"] != "hijack-dns" {
		t.Fatal("TUN DNS does not reach core resolver")
	}
}

func TestCaptureDomains(t *testing.T) {
	for _, domains := range [][]string{nil, {"example.com", "api.example.net"}} {
		if err := validateCaptureDomains(domains); err != nil {
			t.Fatal(err)
		}
	}
	for _, domain := range []string{"", ".", "*", "*.example.com", "https://example.com", "example.com:443", "a..com", "example.com\nremove other", "127.0.0.1", "Example.com"} {
		t.Run(domain, func(t *testing.T) {
			if validateCaptureDomains([]string{domain}) == nil {
				t.Fatal("accepted unsafe resolver domain")
			}
		})
	}
	p := validParams()
	p.SplitDNS = &splitDNSParams{IPv4Range: "198.19.0.0/16", Server: "192.168.1.1", Domains: []string{"example.com"}}
	rules := config(p)["dns"].(map[string]any)["rules"].([]any)
	if rules[0].(map[string]any)["domain_suffix"].([]string)[0] != "example.com" {
		t.Fatal("DNS scope lost")
	}
}
