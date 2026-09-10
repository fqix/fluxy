// Package tun validates TUN requests, generates the core configuration the
// helper feeds to sing-box, and supervises the single core session.
package tun

import (
	"errors"
	"net"
	"net/netip"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"dev.fengqi.fluxy/helper/internal/protocol"
	"dev.fengqi.fluxy/helper/internal/splitdns"
)

// Params is the only TUN request shape the helper accepts. It never carries an
// executable path, a shell command or a configuration file.
type Params struct {
	BridgePort      int              `json:"bridgePort"`
	EgressPort      int              `json:"egressPort"`
	Password        string           `json:"password"`
	InterfaceName   string           `json:"interfaceName"`
	EgressInterface string           `json:"egressInterface"`
	SocksPort       int              `json:"socksPort"`
	RouteCIDRs      []string         `json:"routeCIDRs"`
	SplitDNS        *splitdns.Params `json:"splitDNS,omitempty"`
}

func (p Params) Validate() error {
	port := func(n int) bool { return n >= 1024 && n <= 65535 }
	if !port(p.BridgePort) || !port(p.EgressPort) || p.BridgePort == p.EgressPort || (p.SocksPort != 0 && (!port(p.SocksPort) || p.SocksPort == p.BridgePort || p.SocksPort == p.EgressPort)) {
		return errors.New("invalid ports")
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(p.Password) || !protocol.ValidInterfaceName(p.InterfaceName) {
		return errors.New("invalid TUN identity")
	}
	if len(p.EgressInterface) > 128 || strings.ContainsAny(p.EgressInterface, "\x00\r\n") || p.EgressInterface == p.InterfaceName || p.EgressInterface == "lo" || p.EgressInterface == "lo0" {
		return errors.New("invalid exit interface")
	}
	if p.SplitDNS != nil {
		if p.SocksPort != 0 || p.EgressInterface != "" || len(p.RouteCIDRs) != 0 {
			return errors.New("split DNS cannot override an explicit exit or routes")
		}
		if err := p.SplitDNS.Validate(); err != nil {
			return err
		}
	}
	if p.SocksPort == 0 && p.SplitDNS == nil {
		iface, err := net.InterfaceByName(p.EgressInterface)
		if err != nil || iface.Flags&net.FlagLoopback != 0 {
			return errors.New("exit interface unavailable")
		}
	}
	if len(p.RouteCIDRs) > 128 {
		return errors.New("too many routes")
	}
	for _, route := range p.RouteCIDRs {
		if _, err := netip.ParsePrefix(route); err != nil {
			return errors.New("invalid route CIDR")
		}
	}
	return nil
}

// Config generates the core configuration; the helper never accepts one.
func Config(p Params) map[string]any {
	direct := map[string]any{"type": "direct", "tag": "direct", "bind_interface": p.EgressInterface}
	if p.SocksPort != 0 {
		direct = map[string]any{"type": "socks", "tag": "direct", "server": "127.0.0.1", "server_port": p.SocksPort, "version": "5"}
	}
	tun := map[string]any{"type": "tun", "tag": "capture", "interface_name": p.InterfaceName, "address": []string{"172.31.255.1/30", "fdfe:dcba:9876::1/126"}, "mtu": 1500, "stack": "gvisor", "auto_route": true, "dns_mode": "disabled", "route_exclude_address": []string{"127.0.0.0/8", "::1/128", "169.254.0.0/16", "fe80::/10", "224.0.0.0/4", "ff00::/8"}}
	if protocol.Testing {
		port, _ := strconv.Atoi(os.Getenv("FLUXY_HELPER_TEST_PORT"))
		tun = map[string]any{"type": "socks", "tag": "capture", "listen": "127.0.0.1", "listen_port": port}
	}
	if len(p.RouteCIDRs) > 0 && !protocol.Testing {
		tun["route_address"] = p.RouteCIDRs
	}
	c := map[string]any{
		"log":       map[string]any{"level": "warn", "timestamp": true},
		"dns":       map[string]any{"servers": []any{map[string]any{"type": "local", "tag": "local"}}},
		"inbounds":  []any{tun, map[string]any{"type": "http", "tag": "egress", "listen": "127.0.0.1", "listen_port": p.EgressPort, "users": []any{map[string]any{"username": "fluxy", "password": p.Password}}}},
		"outbounds": []any{direct, map[string]any{"type": "http", "tag": "inspect", "server": "127.0.0.1", "server_port": p.BridgePort, "username": "fluxy", "password": p.Password}},
		"route": map[string]any{"default_domain_resolver": "local", "final": "direct", "rules": []any{
			map[string]any{"inbound": []string{"egress"}, "action": "route", "outbound": "direct"},
			// Reject QUIC before sniffing so browsers can fall back to inspected HTTPS over TCP.
			map[string]any{"inbound": []string{"capture"}, "network": "udp", "port": 443, "action": "reject", "no_drop": true},
			map[string]any{"action": "sniff", "sniffer": []string{"http", "tls"}, "timeout": "300ms"},
			map[string]any{"network": "tcp", "protocol": []string{"http", "tls"}, "action": "route", "outbound": "inspect"},
		}},
	}
	if p.SplitDNS != nil {
		splitdns.ApplyConfig(c, *p.SplitDNS)
	}
	return c
}

// ExeSuffix names the core executable for the host platform.
func ExeSuffix() string {
	if runtime.GOOS == "windows" {
		return ".exe"
	}
	return ""
}
