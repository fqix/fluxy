// Package daemon serves the authenticated, newline-delimited JSON RPC that the
// desktop application uses to control one TUN session and the local trust store.
package daemon

import (
	"bufio"
	"context"
	"crypto/subtle"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"dev.fengqi.fluxy/helper/internal/certs"
	"dev.fengqi.fluxy/helper/internal/platform"
	"dev.fengqi.fluxy/helper/internal/protocol"
	"dev.fengqi.fluxy/helper/internal/tun"
)

func serveConnection(ctx context.Context, c net.Conn, p protocol.Pairing, base string) {
	defer c.Close()
	s := tun.NewSession(base)
	defer s.Stop()
	ended := make(chan struct{})
	defer close(ended)
	go func() {
		select {
		case <-ctx.Done():
			c.Close()
		case <-ended:
		}
	}()
	scanner := bufio.NewScanner(c)
	scanner.Buffer(make([]byte, 4096), 65536)
	for {
		_ = c.SetReadDeadline(time.Now().Add(20 * time.Second))
		if !scanner.Scan() {
			return
		}
		var req struct {
			ID     int             `json:"id"`
			Token  string          `json:"token"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if protocol.Decode(scanner.Bytes(), &req) != nil || subtle.ConstantTimeCompare([]byte(req.Token), []byte(p.Token)) != 1 {
			return
		}
		var err error
		switch req.Method {
		case "status":
		case "tun.stop":
			err = s.Stop()
		case "tun.ready":
			err = s.Ready()
		case "tun.start":
			err = s.Start(req.Params)
		case "ca.install", "ca.remove", "ca.add":
			var cert *x509.Certificate
			cert, err = certs.Parse(req.Params)
			if err == nil && req.Method != "ca.remove" && (time.Now().Before(cert.NotBefore) || time.Now().After(cert.NotAfter)) {
				err = errors.New("certificate expired or not yet valid")
			}
			if err == nil {
				if req.Method == "ca.add" {
					err = certs.AddPublic(cert)
				} else {
					err = certs.Trust(cert, req.Method == "ca.install", base)
				}
			}
		default:
			err = errors.New("unsupported helper method")
		}
		running := s.Running()
		if req.Method == "tun.start" && err == nil && !running {
			err = errors.New(s.Error())
		}
		reply := map[string]any{"id": req.ID, "result": map[string]any{"buildID": p.BuildID, "tunRunning": running, "tunError": s.Error(), "controlPort": s.ControlPort()}}
		if err != nil {
			reply["error"] = err.Error()
		}
		_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if json.NewEncoder(c).Encode(reply) != nil {
			return
		}
	}
}

// run accepts one paired caller at a time until the context is cancelled.
func run(ctx context.Context) error {
	base, err := platform.SecureBase()
	if err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(base, "pairing.json"))
	if err != nil {
		return err
	}
	var p protocol.Pairing
	if err = protocol.Decode(data, &p); err != nil {
		return err
	}
	hex64 := regexp.MustCompile(`^[a-f0-9]{64}$`)
	if !hex64.MatchString(p.Token) || !hex64.MatchString(p.BuildID) || !hex64.MatchString(p.Caller.SHA256) || !filepath.IsAbs(p.Caller.Path) {
		return errors.New("invalid pairing")
	}
	l, err := platform.Listen(p)
	if err != nil {
		return err
	}
	defer func() {
		l.Close()
		if owned, ok := l.(interface{ Release() }); ok {
			owned.Release()
		}
	}()
	go func() { <-ctx.Done(); l.Close() }()
	for {
		c, err := l.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if !platform.PeerAllowed(c, p) {
			c.Close()
			continue
		}
		serveConnection(ctx, c, p, base)
	}
}
