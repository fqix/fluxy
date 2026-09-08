package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/http2"
	xproxy "golang.org/x/net/proxy"
)

type reusableTransport interface {
	http.RoundTripper
	CloseIdleConnections()
}

type transportPool struct {
	mu      sync.Mutex
	entries map[[32]byte]reusableTransport
	order   [][32]byte
}

func (p *transportPool) get(options requestOptions, route string, h2c, websocket bool) (reusableTransport, error) {
	encoded, err := json.Marshal([]any{route, options.CA, options.Cert, options.Key, h2c, websocket})
	if err != nil {
		return nil, fmt.Errorf("encode transport settings: %w", err)
	}
	key := sha256.Sum256(encoded)
	p.mu.Lock()
	defer p.mu.Unlock()
	if existing := p.entries[key]; existing != nil {
		return existing, nil
	}
	config, err := upstreamTLS(options)
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		DialContext:           dialer.DialContext,
		TLSClientConfig:       config,
		ForceAttemptHTTP2:     !websocket,
		DisableCompression:    true,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	if route != "" {
		proxyURL, err := url.Parse(route)
		if err != nil {
			return nil, fmt.Errorf("parse upstream proxy: %w", err)
		}
		switch proxyURL.Scheme {
		case "http", "https":
			transport.Proxy = http.ProxyURL(proxyURL)
		case "socks", "socks5", "socks5h":
			proxyURL.Scheme = "socks5"
			socks, err := xproxy.FromURL(proxyURL, dialer)
			if err != nil {
				return nil, fmt.Errorf("configure SOCKS upstream: %w", err)
			}
			contextDialer, ok := socks.(xproxy.ContextDialer)
			if !ok {
				return nil, errors.New("SOCKS dialer does not support cancellation")
			}
			transport.DialContext = contextDialer.DialContext
		default:
			return nil, fmt.Errorf("unsupported upstream protocol %q", proxyURL.Scheme)
		}
	}
	var result reusableTransport = transport
	if h2c {
		result = &http2.Transport{
			AllowHTTP: true,
			DialTLSContext: func(ctx context.Context, network, address string, _ *tls.Config) (net.Conn, error) {
				if transport.Proxy != nil {
					return connectHTTPProxy(ctx, transport, address)
				}
				return transport.DialContext(ctx, network, address)
			},
		}
	}
	if p.entries == nil {
		p.entries = make(map[[32]byte]reusableTransport)
	}
	if len(p.order) == 32 {
		oldest := p.order[0]
		p.entries[oldest].CloseIdleConnections()
		delete(p.entries, oldest)
		p.order = p.order[1:]
	}
	p.entries[key] = result
	p.order = append(p.order, key)
	return result, nil
}

func (p *transportPool) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, transport := range p.entries {
		transport.CloseIdleConnections()
	}
}

func pemBytes(value json.RawMessage) ([]byte, error) {
	if len(value) == 0 || string(value) == "null" {
		return nil, nil
	}
	if value[0] == '"' {
		var text string
		if err := json.Unmarshal(value, &text); err != nil {
			return nil, fmt.Errorf("decode PEM string: %w", err)
		}
		return []byte(text), nil
	}
	if value[0] == '[' {
		var parts []json.RawMessage
		if err := json.Unmarshal(value, &parts); err != nil {
			return nil, fmt.Errorf("decode PEM chain: %w", err)
		}
		result := []byte{}
		for _, part := range parts {
			data, err := pemBytes(part)
			if err != nil {
				return nil, err
			}
			result = append(result, data...)
			result = append(result, '\n')
		}
		return result, nil
	}
	var data wireBytes
	if err := json.Unmarshal(value, &data); err != nil {
		return nil, err
	}
	return data, nil
}

func upstreamTLS(options requestOptions) (*tls.Config, error) {
	config := &tls.Config{MinVersion: tls.VersionTLS12}
	ca, err := pemBytes(options.CA)
	if err != nil {
		return nil, err
	}
	if len(ca) > 0 {
		config.RootCAs = x509.NewCertPool()
		if !config.RootCAs.AppendCertsFromPEM(ca) {
			return nil, errors.New("invalid upstream CA certificate")
		}
	}
	cert, err := pemBytes(options.Cert)
	if err != nil {
		return nil, err
	}
	key, err := pemBytes(options.Key)
	if err != nil {
		return nil, err
	}
	if len(cert) > 0 || len(key) > 0 {
		identity, err := tls.X509KeyPair(cert, key)
		if err != nil {
			return nil, fmt.Errorf("load client identity: %w", err)
		}
		config.Certificates = []tls.Certificate{identity}
	}
	return config, nil
}

type requestTiming struct {
	mu                             sync.Mutex
	start, dns, connect, tls, sent time.Time
	values                         map[string]float64
}

func newTiming(start time.Time) *requestTiming {
	return &requestTiming{start: start, values: make(map[string]float64)}
}

func (t *requestTiming) trace() *httptrace.ClientTrace {
	set := func(key string, since time.Time) {
		if !since.IsZero() {
			t.values[key] = float64(time.Since(since).Microseconds()) / 1000
		}
	}
	return &httptrace.ClientTrace{
		GetConn:              func(string) { t.mu.Lock(); set("blocked", t.start); t.mu.Unlock() },
		DNSStart:             func(httptrace.DNSStartInfo) { t.mu.Lock(); t.dns = time.Now(); t.mu.Unlock() },
		DNSDone:              func(httptrace.DNSDoneInfo) { t.mu.Lock(); set("dns", t.dns); t.mu.Unlock() },
		ConnectStart:         func(string, string) { t.mu.Lock(); t.connect = time.Now(); t.mu.Unlock() },
		ConnectDone:          func(string, string, error) { t.mu.Lock(); set("connect", t.connect); t.mu.Unlock() },
		TLSHandshakeStart:    func() { t.mu.Lock(); t.tls = time.Now(); t.mu.Unlock() },
		TLSHandshakeDone:     func(tls.ConnectionState, error) { t.mu.Lock(); set("ssl", t.tls); t.mu.Unlock() },
		WroteRequest:         func(httptrace.WroteRequestInfo) { t.mu.Lock(); t.sent = time.Now(); t.mu.Unlock() },
		GotFirstResponseByte: func() { t.mu.Lock(); set("wait", t.sent); t.mu.Unlock() },
	}
}

func (t *requestTiming) snapshot() map[string]float64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	result := make(map[string]float64, len(t.values))
	for key, value := range t.values {
		result[key] = value
	}
	return result
}

func httpHeaders(values map[string]any) http.Header {
	result := make(http.Header)
	for name, value := range values {
		switch value := value.(type) {
		case string:
			result.Add(name, value)
		case []any:
			for _, item := range value {
				result.Add(name, fmt.Sprint(item))
			}
		case []string:
			for _, item := range value {
				result.Add(name, item)
			}
		case float64:
			result.Add(name, fmt.Sprint(value))
		}
	}
	return result
}

func nodeHeaders(values http.Header) map[string]any {
	result := make(map[string]any, len(values))
	for name, parts := range values {
		if len(parts) == 1 && !strings.EqualFold(name, "Set-Cookie") {
			result[strings.ToLower(name)] = parts[0]
		} else {
			result[strings.ToLower(name)] = append([]string{}, parts...)
		}
	}
	return result
}
