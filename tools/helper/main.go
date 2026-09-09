// Fluxy privileged helper. Platform adapters provide local IPC, identity and trust-store access.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const serviceID = "dev.fengqi.fluxy.electron.helper"

type pairing struct {
	UID     int    `json:"uid"`
	SID     string `json:"sid"`
	Token   string `json:"token"`
	BuildID string `json:"buildID"`
	Caller  struct {
		Path     string  `json:"path"`
		SHA256   string  `json:"sha256"`
		TeamID   *string `json:"teamID"`
		Portable bool    `json:"portable,omitempty"`
	} `json:"caller"`
}
type tunParams struct {
	BridgePort      int             `json:"bridgePort"`
	EgressPort      int             `json:"egressPort"`
	Password        string          `json:"password"`
	InterfaceName   string          `json:"interfaceName"`
	EgressInterface string          `json:"egressInterface"`
	SocksPort       int             `json:"socksPort"`
	RouteCIDRs      []string        `json:"routeCIDRs"`
	SplitDNS        *splitDNSParams `json:"splitDNS,omitempty"`
}

func decode(data []byte, target any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}
func validInterfaceName(name string) bool {
	prefix := "fluxy"
	if runtime.GOOS == "darwin" {
		prefix = "utun"
	}
	return regexp.MustCompile("^" + prefix + `[0-9]{4,5}$`).MatchString(name)
}
func (p tunParams) validate() error {
	port := func(n int) bool { return n >= 1024 && n <= 65535 }
	if !port(p.BridgePort) || !port(p.EgressPort) || p.BridgePort == p.EgressPort || (p.SocksPort != 0 && (!port(p.SocksPort) || p.SocksPort == p.BridgePort || p.SocksPort == p.EgressPort)) {
		return errors.New("invalid ports")
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(p.Password) || !validInterfaceName(p.InterfaceName) {
		return errors.New("invalid TUN identity")
	}
	if len(p.EgressInterface) > 128 || strings.ContainsAny(p.EgressInterface, "\x00\r\n") || p.EgressInterface == p.InterfaceName || p.EgressInterface == "lo" || p.EgressInterface == "lo0" {
		return errors.New("invalid exit interface")
	}
	if p.SplitDNS != nil {
		if p.SocksPort != 0 || p.EgressInterface != "" || len(p.RouteCIDRs) != 0 {
			return errors.New("split DNS cannot override an explicit exit or routes")
		}
		if err := p.SplitDNS.validate(); err != nil {
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
func config(p tunParams) map[string]any {
	direct := map[string]any{"type": "direct", "tag": "direct", "bind_interface": p.EgressInterface}
	if p.SocksPort != 0 {
		direct = map[string]any{"type": "socks", "tag": "direct", "server": "127.0.0.1", "server_port": p.SocksPort, "version": "5"}
	}
	tun := map[string]any{"type": "tun", "tag": "capture", "interface_name": p.InterfaceName, "address": []string{"172.31.255.1/30", "fdfe:dcba:9876::1/126"}, "mtu": 1500, "stack": "gvisor", "auto_route": true, "dns_mode": "disabled", "route_exclude_address": []string{"127.0.0.0/8", "::1/128", "169.254.0.0/16", "fe80::/10", "224.0.0.0/4", "ff00::/8"}}
	if helperTesting {
		port, _ := strconv.Atoi(os.Getenv("FLUXY_HELPER_TEST_PORT"))
		tun = map[string]any{"type": "socks", "tag": "capture", "listen": "127.0.0.1", "listen_port": port}
	}
	if len(p.RouteCIDRs) > 0 && !helperTesting {
		tun["route_address"] = p.RouteCIDRs
	}
	c := map[string]any{
		"log":       map[string]any{"level": "warn", "timestamp": true},
		"dns":       map[string]any{"servers": []any{map[string]any{"type": "local", "tag": "local"}}},
		"inbounds":  []any{tun, map[string]any{"type": "http", "tag": "egress", "listen": "127.0.0.1", "listen_port": p.EgressPort, "users": []any{map[string]any{"username": "fluxy", "password": p.Password}}}},
		"outbounds": []any{direct, map[string]any{"type": "http", "tag": "inspect", "server": "127.0.0.1", "server_port": p.BridgePort, "username": "fluxy", "password": p.Password}},
		"route": map[string]any{"default_domain_resolver": "local", "final": "direct", "rules": []any{
			map[string]any{"inbound": []string{"egress"}, "action": "route", "outbound": "direct"},
			map[string]any{"action": "sniff", "sniffer": []string{"http", "tls"}, "timeout": "300ms"},
			map[string]any{"network": "tcp", "protocol": []string{"http", "tls"}, "action": "route", "outbound": "inspect"},
		}},
	}
	if p.SplitDNS != nil {
		applySplitDNSConfig(c, *p.SplitDNS)
	}
	return c
}
func certificate(data json.RawMessage) (*x509.Certificate, error) {
	var encoded string
	if err := decode(data, &encoded); err != nil || len(encoded) > 24000 {
		return nil, errors.New("invalid certificate")
	}
	der, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(der) > 16384 {
		return nil, errors.New("invalid certificate")
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	if !cert.IsCA || cert.Subject.CommonName != "Fluxy Electron Root CA" || !bytes.Equal(cert.RawSubject, cert.RawIssuer) || cert.CheckSignatureFrom(cert) != nil {
		return nil, errors.New("expected self-signed Fluxy root CA")
	}
	return cert, nil
}
func fileHash(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func verifyCaller(path string, p pairing) bool {
	same := path == p.Caller.Path || (runtime.GOOS == "linux" && p.Caller.Portable)
	if runtime.GOOS == "windows" {
		same = strings.EqualFold(path, p.Caller.Path)
	}
	hash, err := fileHash(path)
	return same && err == nil && hash == p.Caller.SHA256
}

type session struct {
	base          string
	child         *exec.Cmd
	input         io.WriteCloser
	done          chan error
	release       func()
	interfaceName string
	dnsCleanup    func() error
	output        *coreOutput
	password      string
	exitError     string
}

func (s *session) running() bool {
	if s.child == nil {
		return false
	}
	select {
	case err := <-s.done:
		s.exitError = s.output.failure("TUN core exited unexpectedly", err, s.password)
		s.child = nil
		s.input.Close()
		s.release()
		if s.dnsCleanup != nil {
			if err := s.dnsCleanup(); err != nil {
				s.exitError += "; " + err.Error()
			} else {
				s.dnsCleanup = nil
			}
			flushSplitDNSCache()
		}
		return false
	default:
		return true
	}
}
func (s *session) stop() error {
	if s.dnsCleanup != nil {
		if err := s.dnsCleanup(); err != nil {
			return err
		}
		s.dnsCleanup = nil
		flushSplitDNSCache()
	}
	if s.running() {
		s.input.Close() // core observes EOF and removes its routes before exiting
		select {
		case <-s.done:
		case <-time.After(12 * time.Second):
			_ = s.child.Process.Kill()
			<-s.done
		}
		s.release()
		s.child = nil
	}
	_ = os.Remove(filepath.Join(s.base, "tun.json"))
	// Windows retains Wintun adapters briefly. Do not report a successful stop early.
	if s.interfaceName != "" {
		until := time.Now().Add(3 * time.Second)
		for {
			if _, err := net.InterfaceByName(s.interfaceName); err != nil {
				s.interfaceName = ""
				break
			}
			if time.Now().After(until) {
				return errors.New("TUN interface has not disappeared")
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	return nil
}
func (s *session) start(raw json.RawMessage) error {
	var p tunParams
	if err := decode(raw, &p); err != nil {
		return err
	}
	if err := p.validate(); err != nil {
		return err
	}
	if err := s.stop(); err != nil {
		return err
	}
	s.exitError = ""
	if _, err := net.InterfaceByName(p.InterfaceName); err == nil {
		return errors.New("TUN interface already exists")
	}
	data, err := json.Marshal(config(p))
	if err != nil {
		return err
	}
	path := filepath.Join(s.base, "tun.json")
	if err = os.WriteFile(path, data, 0600); err != nil {
		return err
	}
	core := filepath.Join(s.base, "fluxy-core"+exeSuffix())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	check := exec.CommandContext(ctx, core, "check", "-c", path)
	check.Env = cleanEnv()
	checkOutput := &coreOutput{}
	check.Stdout, check.Stderr = checkOutput, checkOutput
	if err = check.Run(); err != nil {
		return errors.New(checkOutput.failure("core configuration check failed", err, p.Password))
	}
	child := exec.Command(core, "run", "-c", path)
	child.Env = append(cleanEnv(), "FLUXY_HELPER_STDIN=1")
	output := &coreOutput{}
	child.Stdout, child.Stderr = output, output
	input, err := child.StdinPipe()
	if err != nil {
		return err
	}
	if err = child.Start(); err != nil {
		input.Close()
		return err
	}
	release, err := containChild(child)
	if err != nil {
		input.Close()
		_ = child.Process.Kill()
		_ = child.Wait()
		return err
	}
	s.child = child
	s.input = input
	s.release = release
	done := make(chan error, 1)
	s.done = done
	s.output = output
	s.password = p.Password
	s.interfaceName = p.InterfaceName
	go func() { done <- child.Wait() }()
	if p.SplitDNS != nil && !helperTesting {
		if err = waitSplitDNSReady(p.SplitDNS.Domains); err == nil {
			s.dnsCleanup, err = startSplitDNS(p.InterfaceName, p.SplitDNS.Domains)
		}
		if err != nil {
			if !s.running() && s.exitError != "" {
				err = errors.Join(err, errors.New(s.exitError))
			}
			stopErr := s.stop()
			return errors.Join(err, stopErr)
		}
		flushSplitDNSCache()
	}
	return nil
}

// Never inherit user-controlled dynamic loader, proxy or sing-box settings.
func cleanEnv() []string { return platformEnv() }
func exeSuffix() string {
	if runtime.GOOS == "windows" {
		return ".exe"
	}
	return ""
}
func serveConnection(ctx context.Context, c net.Conn, p pairing, base string) {
	defer c.Close()
	s := session{base: base}
	defer s.stop()
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
		if decode(scanner.Bytes(), &req) != nil || subtle.ConstantTimeCompare([]byte(req.Token), []byte(p.Token)) != 1 {
			return
		}
		var err error
		switch req.Method {
		case "status":
		case "tun.stop":
			err = s.stop()
		case "tun.start":
			err = s.start(req.Params)
		case "ca.install", "ca.remove", "ca.add":
			var cert *x509.Certificate
			cert, err = certificate(req.Params)
			if err == nil && req.Method != "ca.remove" && (time.Now().Before(cert.NotBefore) || time.Now().After(cert.NotAfter)) {
				err = errors.New("certificate expired or not yet valid")
			}
			if err == nil {
				if req.Method == "ca.add" {
					err = addPublicCertificate(cert)
				} else {
					err = trustCertificate(cert, req.Method == "ca.install", base)
				}
			}
		default:
			err = errors.New("unsupported helper method")
		}
		running := s.running()
		if req.Method == "tun.start" && err == nil && !running {
			err = errors.New(s.exitError)
		}
		reply := map[string]any{"id": req.ID, "result": map[string]any{"buildID": p.BuildID, "tunRunning": running, "tunError": s.exitError}}
		if err != nil {
			reply["error"] = err.Error()
		}
		_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if json.NewEncoder(c).Encode(reply) != nil {
			return
		}
	}
}
func run(ctx context.Context) error {
	base, err := secureBase()
	if err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(base, "pairing.json"))
	if err != nil {
		return err
	}
	var p pairing
	if err = decode(data, &p); err != nil {
		return err
	}
	hex64 := regexp.MustCompile(`^[a-f0-9]{64}$`)
	if !hex64.MatchString(p.Token) || !hex64.MatchString(p.BuildID) || !hex64.MatchString(p.Caller.SHA256) || !filepath.IsAbs(p.Caller.Path) {
		return errors.New("invalid pairing")
	}
	l, err := listen(p)
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
		if !peerAllowed(c, p) {
			c.Close()
			continue
		}
		serveConnection(ctx, c, p, base)
	}
}
func command() error {
	if len(os.Args) == 1 {
		return platformMain()
	}
	if os.Args[1] == "setup-native" || os.Args[1] == "setup-elevated" {
		return nativeSetupCommand()
	}
	if len(os.Args) != 2 {
		return errors.New("unsupported helper command")
	}
	if os.Args[1] == "user-sid" {
		value, err := platformNetworkCommand("user-sid", nil)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(value)
	}
	if os.Args[1] == "dns-lease" {
		return platformDNSLease()
	}
	data, err := io.ReadAll(io.LimitReader(os.Stdin, 65537))
	if err != nil {
		return err
	}
	if len(data) > 65536 {
		return errors.New("oversized helper input")
	}
	switch os.Args[1] {
	case "system-proxy", "certificate-status", "network-snapshot", "dns-status", "proxy-processes", "route-interface":
		value, err := platformNetworkCommand(os.Args[1], data)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(value)
	case "authorize-desktop":
		var request struct {
			Command     string `json:"command"`
			Certificate string `json:"certificate"`
		}
		if err = decode(data, &request); err != nil {
			return err
		}
		if request.Command == "" || strings.ContainsRune(request.Command, 0) {
			return errors.New("invalid desktop setup command")
		}
		var cert *x509.Certificate
		if request.Certificate != "" {
			raw, _ := json.Marshal(request.Certificate)
			cert, err = certificate(raw)
			if err != nil {
				return err
			}
			if time.Now().Before(cert.NotBefore) || time.Now().After(cert.NotAfter) {
				return errors.New("certificate expired or not yet valid")
			}
		}
		return authorizeDesktop(request.Command, cert)
	case "trust-ca-privileged":
		cert, err := certificate(data)
		if err != nil {
			return err
		}
		if time.Now().Before(cert.NotBefore) || time.Now().After(cert.NotAfter) {
			return errors.New("certificate expired or not yet valid")
		}
		return privilegedTrustCertificate(cert)
	case "validate-tun":
		var p tunParams
		if err = decode(data, &p); err != nil {
			return err
		}
		if err = p.validate(); err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(config(p))
	case "trust-ca-desktop":
		cert, err := certificate(data)
		if err != nil {
			return err
		}
		if time.Now().Before(cert.NotBefore) || time.Now().After(cert.NotAfter) {
			return errors.New("certificate expired or not yet valid")
		}
		return desktopTrustCertificate(cert)
	case "validate-ca":
		raw, _ := json.Marshal(string(data))
		if _, err = certificate(raw); err != nil {
			return fmt.Errorf("Invalid CA: %w", err)
		}
		return nil
	default:
		return errors.New("unsupported helper command")
	}
}
func main() {
	if err := command(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
