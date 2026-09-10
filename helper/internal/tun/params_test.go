package tun

import (
	"reflect"
	"runtime"
	"strings"
	"testing"

	"dev.fengqi.fluxy/helper/internal/protocol"
	"dev.fengqi.fluxy/helper/internal/splitdns"
)

func TestQUICFallback(t *testing.T) {
	for _, scoped := range []bool{false, true} {
		p := validParams()
		index := 1
		if scoped {
			p.SplitDNS = splitParams()
			index = 2 // DNS hijacking must stay ahead of rejection.
		}
		rules := Config(p)["route"].(map[string]any)["rules"].([]any)
		want := map[string]any{"inbound": []string{"capture"}, "network": "udp", "port": 443, "action": "reject", "no_drop": true}
		if !reflect.DeepEqual(rules[index], want) {
			t.Fatalf("scoped=%v: QUIC can bypass inspection: %v", scoped, rules)
		}
		if rules[index+1].(map[string]any)["action"] != "sniff" {
			t.Fatal("QUIC rejection must precede TCP inspection")
		}
	}
}

func validParams() Params {
	name := "fluxy2345"
	if runtime.GOOS == "darwin" {
		name = "utun2345"
	}
	return Params{BridgePort: 6060, EgressPort: 6061, Password: strings.Repeat("a", 43), InterfaceName: name, SocksPort: 1080, RouteCIDRs: []string{"203.0.113.0/24", "2001:db8::/32"}}
}
func TestValidation(t *testing.T) {
	if err := validParams().Validate(); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*Params){
		"privileged port": func(p *Params) { p.BridgePort = 80 }, "loop": func(p *Params) { p.EgressPort = p.BridgePort },
		"SOCKS loop": func(p *Params) { p.SocksPort = p.EgressPort }, "password": func(p *Params) { p.Password = "weak" },
		"interface": func(p *Params) { p.InterfaceName = "eth0" }, "exit control": func(p *Params) { p.EgressInterface = "eth0\n" },
		"route": func(p *Params) { p.RouteCIDRs = []string{"default"} }, "exit missing": func(p *Params) { p.SocksPort = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			p := validParams()
			change(&p)
			if p.Validate() == nil {
				t.Fatal("accepted invalid request")
			}
		})
	}
	var p Params
	if protocol.Decode([]byte(`{"command":"/bin/sh"}`), &p) == nil {
		t.Fatal("accepted unknown field")
	}
	if protocol.Decode([]byte(`{} {}`), &p) == nil {
		t.Fatal("accepted trailing JSON")
	}
}
func TestConfig(t *testing.T) {
	p := validParams()
	c := Config(p)
	outbound := c["outbounds"].([]any)[0].(map[string]any)
	if outbound["server"] != "127.0.0.1" || outbound["type"] != "socks" {
		t.Fatal("unbounded exit")
	}
	inbound := c["inbounds"].([]any)[0].(map[string]any)
	if inbound["interface_name"] != p.InterfaceName || inbound["stack"] != "gvisor" {
		t.Fatal("wrong capture profile")
	}
	p.SocksPort = 0
	p.EgressInterface = "Ethernet 2"
	if Config(p)["outbounds"].([]any)[0].(map[string]any)["bind_interface"] != "Ethernet 2" {
		t.Fatal("missing interface binding")
	}
}

func splitParams() *splitdns.Params {
	return &splitdns.Params{IPv4Range: "198.19.0.0/16", Server: "192.168.1.1", Domains: []string{"example.com"}}
}
func TestSplitDNSValidation(t *testing.T) {
	p := Params{BridgePort: 6060, EgressPort: 6061, Password: strings.Repeat("a", 43),
		InterfaceName: "utun2345", SplitDNS: splitParams()}
	if runtime.GOOS == "windows" {
		p.InterfaceName = "fluxy2345"
	}
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		if p.SplitDNS.Validate() == nil {
			t.Fatal("accepted unsupported platform")
		}
		return
	}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name   string
		change func(*Params)
	}{
		{"missing domains", func(p *Params) { p.SplitDNS.Domains = nil }},
		{"invalid domain", func(p *Params) { p.SplitDNS.Domains = []string{"https://example.com"} }},
		{"default route", func(p *Params) { p.SplitDNS.IPv4Range = "0.0.0.0/0" }},
		{"DNS loop", func(p *Params) { p.SplitDNS.Server = splitdns.Address }},
		{"fake IPv4 loop", func(p *Params) { p.SplitDNS.Server = "198.19.1.1" }},
		{"fake IPv6 loop", func(p *Params) { p.SplitDNS.Server = "fd7a:115c:a1e0::2" }},
		{"server injection", func(p *Params) { p.SplitDNS.Server = "127.0.0.1\nremove other" }},
		{"SOCKS override", func(p *Params) { p.SocksPort = 7897 }},
		{"route override", func(p *Params) { p.RouteCIDRs = []string{"0.0.0.0/0"} }},
		{"interface override", func(p *Params) { p.EgressInterface = "en0" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			next := p
			dns := *p.SplitDNS
			next.SplitDNS = &dns
			test.change(&next)
			if next.Validate() == nil {
				t.Fatal("accepted unsafe split DNS profile")
			}
		})
	}
}
func TestSplitDNSConfig(t *testing.T) {
	p := validParams()
	p.SocksPort = 0
	p.RouteCIDRs = nil
	p.SplitDNS = splitParams()
	c := Config(p)
	inbound := c["inbounds"].([]any)[0].(map[string]any)
	routes := inbound["route_address"].([]string)
	if len(routes) != 3 || routes[0] != p.SplitDNS.IPv4Range || routes[1] != splitdns.FakeIPv6Range || routes[2] != splitdns.Address+"/32" {
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
	rules := dns["rules"].([]any)
	if rules[0].(map[string]any)["domain_suffix"].([]string)[0] != "example.com" {
		t.Fatal("DNS scope lost")
	}
}
