package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
)

func TestSplitDNSResolverProcess(t *testing.T) {
	// An isolated child emulates scutil; no system DNS or TUN is changed.
	if !slices.Contains(os.Args, "--fake-scutil") {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	temporary := false
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "add State:/Network/Service/"+serviceID+".utun2345/DNS") &&
			strings.HasSuffix(line, " temporary") {
			temporary = true
		}
		if strings.HasPrefix(line, "show ") {
			if !temporary {
				os.Exit(2)
			}
			fmt.Println("0 : " + splitDNSAddress)
		}
	}
	// Exit only when the owner closes stdin, just like a temporary scutil session.
	os.Exit(0)
}

func TestSplitDNSResolverOwnership(t *testing.T) {
	command := exec.Command(os.Args[0], "-test.run=^TestSplitDNSResolverProcess$", "--", "--fake-scutil")
	cleanup, err := startSplitDNSProcess("utun2345", []string{"example.com"}, command)
	if err != nil {
		t.Fatal(err)
	}
	if err = cleanup(); err != nil {
		t.Fatal(err)
	}
	if !command.ProcessState.Success() {
		t.Fatal("DNS owner was not cleanly closed")
	}
	if err = cleanup(); err != nil {
		t.Fatal("cleanup was not idempotent:", err)
	}
	if _, err = startSplitDNSProcess("utun2345\nremove other", []string{"example.com"}, exec.Command("unused")); err == nil {
		t.Fatal("accepted an unbounded resolver key")
	}
}

func TestSplitDNSDomainScope(t *testing.T) {
	script := splitDNSScript("utun2345", []string{"example.com", "api.example.net"})
	if !strings.Contains(script, "d.add SupplementalMatchDomains * example.com api.example.net\n") ||
		strings.Contains(script, `SupplementalMatchDomains * ""`) {
		t.Fatal("resolver is not restricted to the selected suffixes")
	}
	for _, test := range []struct {
		name    string
		domains []string
	}{
		{"nil domains", nil},
		{"empty domains", []string{}},
		{"invalid domain", []string{"example.com\nremove other"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			command := exec.Command("unused")
			if _, err := startSplitDNSProcess("utun2345", test.domains, command); err == nil {
				t.Fatal("unvalidated domain reached scutil")
			}
			if command.Process != nil {
				t.Fatal("started a resolver process for invalid domains")
			}
		})
	}
}
