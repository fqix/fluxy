package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func validParams() tunParams {
	name := "fluxy2345"
	if runtime.GOOS == "darwin" {
		name = "utun2345"
	}
	return tunParams{BridgePort: 6060, EgressPort: 6061, Password: strings.Repeat("a", 43), InterfaceName: name, SocksPort: 1080, RouteCIDRs: []string{"203.0.113.0/24", "2001:db8::/32"}}
}
func TestValidation(t *testing.T) {
	if err := validParams().validate(); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*tunParams){
		"privileged port": func(p *tunParams) { p.BridgePort = 80 }, "loop": func(p *tunParams) { p.EgressPort = p.BridgePort },
		"SOCKS loop": func(p *tunParams) { p.SocksPort = p.EgressPort }, "password": func(p *tunParams) { p.Password = "weak" },
		"interface": func(p *tunParams) { p.InterfaceName = "eth0" }, "exit control": func(p *tunParams) { p.EgressInterface = "eth0\n" },
		"route": func(p *tunParams) { p.RouteCIDRs = []string{"default"} }, "exit missing": func(p *tunParams) { p.SocksPort = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			p := validParams()
			change(&p)
			if p.validate() == nil {
				t.Fatal("accepted invalid request")
			}
		})
	}
	var p tunParams
	if decode([]byte(`{"command":"/bin/sh"}`), &p) == nil {
		t.Fatal("accepted unknown field")
	}
	if decode([]byte(`{} {}`), &p) == nil {
		t.Fatal("accepted trailing JSON")
	}
}
func TestConfig(t *testing.T) {
	p := validParams()
	c := config(p)
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
	if config(p)["outbounds"].([]any)[0].(map[string]any)["bind_interface"] != "Ethernet 2" {
		t.Fatal("missing interface binding")
	}
}
func TestRPCAuthAndCancellation(t *testing.T) {
	for _, token := range []string{strings.Repeat("a", 64), "bad"} {
		t.Run(token[:3], func(t *testing.T) {
			server, client := net.Pipe()
			defer client.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan struct{})
			p := pairing{Token: strings.Repeat("a", 64), BuildID: "build"}
			dir := t.TempDir()
			go func() { serveConnection(ctx, server, p, dir); close(done) }()
			client.SetDeadline(time.Now().Add(time.Second))
			if err := json.NewEncoder(client).Encode(map[string]any{"id": 1, "token": token, "method": "status", "params": nil}); err != nil {
				t.Fatal(err)
			}
			line, err := bufio.NewReader(client).ReadBytes('\n')
			if token == p.Token {
				if err != nil || !strings.Contains(string(line), `"tunRunning":false`) {
					t.Fatalf("reply %s: %v", line, err)
				}
			} else if err == nil {
				t.Fatal("unauthenticated request accepted")
			}
			cancel()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("connection did not close")
			}
		})
	}
}
func TestCertificateBoundary(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Fluxy Electron Root CA"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	check := func() error {
		der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
		if err != nil {
			return err
		}
		raw, _ := json.Marshal(base64.StdEncoding.EncodeToString(der))
		_, err = certificate(raw)
		return err
	}
	if err = check(); err != nil {
		t.Fatal(err)
	}
	cert.Subject.CommonName = "Other CA"
	if check() == nil {
		t.Fatal("accepted unrelated root")
	}
	cert.Subject.CommonName = "Fluxy Electron Root CA"
	cert.IsCA = false
	if check() == nil {
		t.Fatal("accepted leaf certificate")
	}
}
func TestCallerHashPin(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app")
	if err := os.WriteFile(path, []byte("expected"), 0600); err != nil {
		t.Fatal(err)
	}
	p := pairing{}
	p.Caller.Path = path
	p.Caller.SHA256, _ = fileHash(path)
	if !verifyCaller(path, p) {
		t.Fatal("expected caller rejected")
	}
	if err := os.WriteFile(path, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if verifyCaller(path, p) {
		t.Fatal("changed executable accepted")
	}
}

// The same test binary acts as a harmless core fixture in child processes.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "check" {
		os.Exit(0)
	}
	if len(os.Args) > 1 && os.Args[1] == "run" {
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}
	os.Exit(m.Run())
}
func TestDisconnectStopsCore(t *testing.T) {
	base := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(base, "sing-box"+exeSuffix()), data, 0700); err != nil {
		t.Fatal(err)
	}
	server, client := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	p := pairing{Token: strings.Repeat("a", 64), BuildID: "fixture"}
	go func() { serveConnection(ctx, server, p, base); close(done) }()
	client.SetDeadline(time.Now().Add(15 * time.Second))
	if err = json.NewEncoder(client).Encode(map[string]any{"id": 1, "token": p.Token, "method": "tun.start", "params": validParams()}); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(client).ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(line), `"tunRunning":true`) {
		t.Fatalf("core did not start: %s", line)
	}
	client.Close()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("orphaned core after disconnect")
	}
	if _, err = os.Stat(filepath.Join(base, "tun.json")); !os.IsNotExist(err) {
		t.Fatal("session configuration not cleaned")
	}
}
