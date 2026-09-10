package splitdns

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"reflect"
	"testing"

	"dev.fengqi.fluxy/helper/internal/protocol"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func TestNativeDNSOwnerFixture(t *testing.T) {
	mode := os.Args[len(os.Args)-1]
	if mode != "--dns-owner" && mode != "--dns-owner-crash" {
		return
	}
	reader := bufio.NewReader(os.Stdin)
	if _, err := reader.ReadString('\n'); err != nil {
		os.Exit(2)
	}
	fmt.Println("FLUXY_DNS_READY")
	if mode == "--dns-owner-crash" {
		os.Exit(2)
	}
	_, _ = io.Copy(io.Discard, reader)
	fmt.Println("FLUXY_DNS_CLEAN")
	os.Exit(0)
}

func TestNativeDNSOwnerProcessLease(t *testing.T) {
	for _, mode := range []string{"--dns-owner", "--dns-owner-crash"} {
		t.Run(mode, func(t *testing.T) {
			restored := false
			command := exec.Command(os.Args[0], "-test.run=^TestNativeDNSOwnerFixture$", "--", mode)
			cleanup, err := startWindowsDNSOwner(command, []byte("{}"), func() error { restored = true; return nil })
			if err != nil {
				t.Fatal(err)
			}
			if err := cleanup(); err != nil {
				t.Fatal(err)
			}
			if restored != (mode == "--dns-owner-crash") {
				t.Fatal("unexpected recovery", restored)
			}
		})
	}
}

// Real Win32 registry calls against an isolated HKCU key: no host DNS changes.
func testNRPT(t *testing.T) nrptStore {
	t.Helper()
	guid, err := windows.GenerateGUID()
	if err != nil {
		t.Fatal(err)
	}
	path := `Software\FluxyTests\` + guid.String()
	root, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.ALL_ACCESS)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		var remove func(registry.Key, string)
		remove = func(parent registry.Key, name string) {
			key, err := registry.OpenKey(parent, name, registry.ALL_ACCESS)
			if err != nil {
				return
			}
			names, _ := key.ReadSubKeyNames(-1)
			for _, child := range names {
				remove(key, child)
			}
			key.Close()
			if err := registry.DeleteKey(parent, name); err != nil {
				t.Error(err)
			}
		}
		root.Close()
		remove(registry.CURRENT_USER, path)
	})
	return nrptStore{root: root, local: "local", policy: "policy", flush: func() error { return nil }}
}

func seedDNSRule(t *testing.T, s nrptStore, path, owner string, domains []string) {
	t.Helper()
	key, _, err := registry.CreateKey(s.root, path, registry.ALL_ACCESS)
	if err != nil {
		t.Fatal(err)
	}
	defer key.Close()
	if err := key.SetStringValue("Comment", owner); err != nil {
		t.Fatal(err)
	}
	if err := key.SetStringsValue("Name", domains); err != nil {
		t.Fatal(err)
	}
}

func TestNativeNRPTScopeAndCleanup(t *testing.T) {
	s := testNRPT(t)
	seedDNSRule(t, s, `local\foreign`, "other-vpn", []string{".corp.test"})
	cleanup, err := s.install("fluxy2345", []string{"example.com", "api.example.net"})
	if err != nil {
		t.Fatal(err)
	}
	rules, err := s.rules(s.local)
	if err != nil || len(rules) != 3 {
		t.Fatal(rules, err)
	}
	for _, rule := range rules {
		if rule.owner == "other-vpn" {
			continue
		}
		key, err := registry.OpenKey(s.root, s.local+`\`+rule.id, registry.READ)
		if err != nil {
			t.Fatal(err)
		}
		version, _, _ := key.GetIntegerValue("Version")
		flags, _, _ := key.GetIntegerValue("ConfigOptions")
		server, _, _ := key.GetStringValue("GenericDNSServers")
		key.Close()
		if version != 2 || flags != 8 || server != Address || len(rule.domains) != 2 || rule.domains[1] != "."+rule.domains[0] {
			t.Fatal("invalid native NRPT values", rule)
		}
	}
	if exists, err := s.exists("fluxy2345"); err != nil || !exists {
		t.Fatal(exists, err)
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	rules, err = s.rules(s.local)
	if err != nil || len(rules) != 1 || rules[0].owner != "other-vpn" {
		t.Fatal("foreign DNS modified", rules, err)
	}
}

func TestNativeNRPTRejectsPolicyConflicts(t *testing.T) {
	for _, scope := range []string{".", ".example.com", "example.com", ".child.example.com", ".com"} {
		t.Run(scope, func(t *testing.T) {
			s := testNRPT(t)
			seedDNSRule(t, s, `local\foreign`, "vpn", []string{scope})
			if _, err := s.install("fluxy2345", []string{"example.com"}); err == nil {
				t.Fatal("accepted overlapping DNS policy")
			}
		})
	}
	s := testNRPT(t)
	seedDNSRule(t, s, `policy\gpo`, "enterprise", []string{".unrelated.test"})
	if _, err := s.install("fluxy2345", []string{"example.com"}); err == nil {
		t.Fatal("accepted policy that suppresses local NRPT")
	}
}

func TestNativeDNSLeaseEOFAndRollback(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "EOF", true: "activation failure"}[fail], func(t *testing.T) {
			s := testNRPT(t)
			if fail {
				s.verify = func([]string) error { return errors.New("policy did not activate") }
			}
			reader, writer := io.Pipe()
			var output bytes.Buffer
			done := make(chan error, 1)
			go func() {
				done <- runNativeDNSLease(reader, &output, s, dnsLeaseRequest{InterfaceName: "fluxy2345", DNS: Params{Domains: []string{"example.com"}}})
			}()
			writer.Close() // the same EOF the owner gets when its helper process dies
			err := <-done
			reader.Close()
			if (err != nil) != fail {
				t.Fatal(err)
			}
			if exists, err := s.exists("fluxy2345"); err != nil || exists {
				t.Fatal("lease left DNS rules behind", err)
			}
			if !bytes.Contains(output.Bytes(), []byte("FLUXY_DNS_CLEAN")) {
				t.Fatal("missing cleanup confirmation")
			}
			if fail && bytes.Contains(output.Bytes(), []byte("FLUXY_DNS_READY")) {
				t.Fatal("reported failed activation as ready")
			}
		})
	}
}

func TestNativeDNSCleanupRetry(t *testing.T) {
	s := testNRPT(t)
	cleanup, err := s.install("fluxy2345", []string{"example.com"})
	if err != nil {
		t.Fatal(err)
	}
	// install captures its store by value; inject a flushing failure into a second
	// cleanup path to prove removed rules and cache restoration remain retryable.
	s.flush = func() error { return errors.New("flush failed") }
	if err := s.remove(protocol.ServiceID + ".fluxy2345"); err == nil {
		t.Fatal("lost restoration failure")
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
}

func TestNativeDNSRejectsUnboundedInput(t *testing.T) {
	s := testNRPT(t)
	for _, domains := range [][]string{nil, {"example.com'; exit"}, {"."}} {
		if _, err := s.install("fluxy2345", domains); err == nil {
			t.Fatal("accepted invalid domain")
		}
	}
	if _, err := s.install("fluxy2345\nexit", []string{"example.com"}); err == nil {
		t.Fatal("accepted invalid name")
	}
	if !reflect.DeepEqual(ownedDNSInterface("other.fluxy2345"), "") {
		t.Fatal("accepted foreign ownership")
	}
}
