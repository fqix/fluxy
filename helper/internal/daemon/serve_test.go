package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"dev.fengqi.fluxy/helper/internal/protocol"
	"dev.fengqi.fluxy/helper/internal/tun"
)

func validParams() tun.Params {
	name := "fluxy2345"
	if runtime.GOOS == "darwin" {
		name = "utun2345"
	}
	return tun.Params{BridgePort: 6060, EgressPort: 6061, Password: strings.Repeat("a", 43), InterfaceName: name, SocksPort: 1080, RouteCIDRs: []string{"203.0.113.0/24", "2001:db8::/32"}}
}
func TestRPCAuthAndCancellation(t *testing.T) {
	for _, token := range []string{strings.Repeat("a", 64), "bad"} {
		t.Run(token[:3], func(t *testing.T) {
			server, client := net.Pipe()
			defer client.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan struct{})
			p := protocol.Pairing{Token: strings.Repeat("a", 64), BuildID: "build"}
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
	if err = os.WriteFile(filepath.Join(base, "sing-box"+tun.ExeSuffix()), data, 0700); err != nil {
		t.Fatal(err)
	}
	server, client := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	p := protocol.Pairing{Token: strings.Repeat("a", 64), BuildID: "fixture"}
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
