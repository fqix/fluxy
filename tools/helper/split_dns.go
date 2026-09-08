package main

import (
	"errors"
	"net/netip"
	"regexp"
	"runtime"
	"strings"
)

type splitDNSParams struct {
	IPv4Range string   `json:"ipv4Range"`
	Server    string   `json:"server"`
	Domains   []string `json:"domains"`
}

const splitDNSAddress = "172.31.255.2"
const fakeIPv6Range = "fd7a:115c:a1e0::/48"

func validateCaptureDomains(domains []string) error {
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

func (p splitDNSParams) validate() error {
	if runtime.GOOS != "darwin" {
		return errors.New("split DNS capture is only supported on macOS")
	}
	if err := validateCaptureDomains(p.Domains); err != nil {
		return err
	}
	switch p.IPv4Range {
	case "198.19.0.0/16", "100.127.0.0/16", "172.30.0.0/16":
	default:
		return errors.New("invalid Fake IP range")
	}
	server, err := netip.ParseAddr(p.Server)
	if err != nil || server.IsUnspecified() || server.IsMulticast() || server.Zone() != "" ||
		p.Server == splitDNSAddress || netip.MustParsePrefix(p.IPv4Range).Contains(server) ||
		netip.MustParsePrefix(fakeIPv6Range).Contains(server) {
		return errors.New("invalid upstream DNS server")
	}
	return nil
}

func applySplitDNSConfig(c map[string]any, p splitDNSParams) {
	inbound := c["inbounds"].([]any)[0].(map[string]any)
	if !helperTesting {
		inbound["address"] = []string{"172.31.255.1/30", "fd7a:115c:a1e1::1/126"}
		inbound["route_address"] = []string{p.IPv4Range, fakeIPv6Range, splitDNSAddress + "/32"}
	}
	// Real destinations follow existing routes, including an existing VPN's TUN.
	delete(c["outbounds"].([]any)[0].(map[string]any), "bind_interface")
	c["dns"] = map[string]any{
		"servers": []any{
			map[string]any{"type": "udp", "tag": "local", "server": p.Server},
			map[string]any{
				"type": "fakeip", "tag": "fakeip",
				"inet4_range": p.IPv4Range, "inet6_range": fakeIPv6Range,
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
