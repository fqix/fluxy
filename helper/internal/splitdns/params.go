// Package splitdns validates and applies the scoped Fake IP DNS profile, and
// owns the per-platform resolver registration for one TUN session.
package splitdns

import (
	"errors"
	"net/netip"
	"regexp"
	"runtime"
	"strings"

	"dev.fengqi.fluxy/helper/internal/protocol"
)

type Params struct {
	IPv4Range string   `json:"ipv4Range"`
	Server    string   `json:"server"`
	Domains   []string `json:"domains"`
}

const Address = "172.31.255.2"
const FakeIPv6Range = "fd7a:115c:a1e0::/48"

func validateDomains(domains []string) error {
	if len(domains) == 0 {
		return errors.New("at least one capture domain is required")
	}
	if len(domains) > 100 {
		return errors.New("too many capture domains")
	}
	pattern := regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)
	for _, domain := range domains {
		if len(domain) > 253 || !pattern.MatchString(domain) || strings.Trim(domain, "0123456789.") == "" {
			return errors.New("invalid capture domain")
		}
	}
	return nil
}

func (p Params) Validate() error {
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		return errors.New("split DNS capture is only supported on macOS and Windows")
	}
	if err := validateDomains(p.Domains); err != nil {
		return err
	}
	switch p.IPv4Range {
	case "198.19.0.0/16", "100.127.0.0/16", "172.30.0.0/16":
	default:
		return errors.New("invalid Fake IP range")
	}
	server, err := netip.ParseAddr(p.Server)
	if err != nil || server.IsUnspecified() || server.IsMulticast() || server.Zone() != "" ||
		p.Server == Address || netip.MustParsePrefix(p.IPv4Range).Contains(server) ||
		netip.MustParsePrefix(FakeIPv6Range).Contains(server) {
		return errors.New("invalid upstream DNS server")
	}
	return nil
}

func ApplyConfig(c map[string]any, p Params) {
	inbound := c["inbounds"].([]any)[0].(map[string]any)
	if !protocol.Testing {
		inbound["address"] = []string{"172.31.255.1/30", "fd7a:115c:a1e1::1/126"}
		inbound["route_address"] = []string{p.IPv4Range, FakeIPv6Range, Address + "/32"}
	}
	// Real destinations follow existing routes, including an existing VPN's TUN.
	delete(c["outbounds"].([]any)[0].(map[string]any), "bind_interface")
	c["dns"] = map[string]any{
		"servers": []any{
			map[string]any{"type": "udp", "tag": "local", "server": p.Server},
			map[string]any{
				"type": "fakeip", "tag": "fakeip",
				"inet4_range": p.IPv4Range, "inet6_range": FakeIPv6Range,
			},
		},
		"rules": []any{map[string]any{
			"inbound": []string{"capture"}, "query_type": []string{"A", "AAAA"},
			"domain_suffix": p.Domains,
			"action":        "route", "server": "fakeip", "rewrite_ttl": 1,
		}},
		"final": "local", "independent_cache": true,
	}
	route := c["route"].(map[string]any)
	rules := route["rules"].([]any)
	route["rules"] = append([]any{rules[0], map[string]any{
		"inbound": []string{"capture"}, "port": 53, "action": "hijack-dns",
	}}, rules[1:]...)
}
