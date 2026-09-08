package main

import (
	"context"
	"fmt"
	"testing"

	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing/common/json"
)

func TestCoreContextSupportsCaptureProfile(t *testing.T) {
	data := []byte(`{
        "dns":{"servers":[{"type":"local","tag":"local"},{"type":"fakeip","tag":"fakeip","inet4_range":"198.19.0.0/16","inet6_range":"fd7a:115c:a1e0::/48"}]},
        "inbounds":[
            {"type":"tun","tag":"capture","address":["172.31.255.1/30"],"stack":"gvisor","auto_route":true,"dns_mode":"disabled"},
            {"type":"http","tag":"egress","listen":"127.0.0.1","listen_port":19092},
            {"type":"socks","tag":"test","listen":"127.0.0.1","listen_port":19093}
        ],
        "outbounds":[{"type":"direct","tag":"direct"},
            {"type":"http","tag":"inspect","server":"127.0.0.1","server_port":19091},
            {"type":"socks","tag":"upstream","server":"127.0.0.1","server_port":7897}],
        "route":{"default_domain_resolver":"local","find_process":true,"final":"direct", "rules":[
            {"inbound":["egress"],"action":"route","outbound":"direct"},
            {"action":"sniff","sniffer":["http","tls"],"timeout":"300ms"},
            {"network":"tcp","protocol":["http"],"action":"route","outbound":"inspect"}
        ]}
    }`)
	_, err := json.UnmarshalExtendedContext[option.Options](coreContext(context.Background()), data)
	if err != nil {
		t.Fatal(err)
	}
}

func TestCoreContextRejectsExcludedProtocols(t *testing.T) {
	for _, protocol := range []string{"vmess", "vless", "shadowsocks", "trojan", "hysteria2", "tuic", "ssh", "anytls", "selector"} {
		t.Run(protocol, func(t *testing.T) {
			data := []byte(fmt.Sprintf(`{"outbounds":[{"type":%q,"tag":"excluded"}]}`, protocol))
			if _, err := json.UnmarshalExtendedContext[option.Options](coreContext(context.Background()), data); err == nil {
				t.Fatalf("excluded protocol %q was accepted", protocol)
			}
		})
	}
}

func TestCoreContextRejectsServicesAndEndpoints(t *testing.T) {
	for _, config := range []string{
		`{"endpoints":[{"type":"wireguard","tag":"wg"}]}`,
		`{"endpoints":[{"type":"tailscale","tag":"ts"}]}`,
		`{"services":[{"type":"api","tag":"api"}]}`,
	} {
		if _, err := json.UnmarshalExtendedContext[option.Options](coreContext(context.Background()), []byte(config)); err == nil {
			t.Fatalf("excluded feature accepted: %s", config)
		}
	}
}
