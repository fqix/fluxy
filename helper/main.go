// Fluxy privileged helper. It runs as a daemon for the desktop application and
// exposes a few typed command-line entry points for elevated setup and native
// queries. Every capability lives in a package under internal/.
package main

import (
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"dev.fengqi.fluxy/helper/internal/certs"
	"dev.fengqi.fluxy/helper/internal/daemon"
	"dev.fengqi.fluxy/helper/internal/protocol"
	"dev.fengqi.fluxy/helper/internal/setup"
	"dev.fengqi.fluxy/helper/internal/splitdns"
	"dev.fengqi.fluxy/helper/internal/tun"
	"dev.fengqi.fluxy/helper/internal/winnet"
)

func valid(cert *x509.Certificate) error {
	if time.Now().Before(cert.NotBefore) || time.Now().After(cert.NotAfter) {
		return errors.New("certificate expired or not yet valid")
	}
	return nil
}
func command() error {
	if len(os.Args) == 1 {
		return daemon.Main()
	}
	if os.Args[1] == "setup-native" || os.Args[1] == "setup-elevated" {
		return setup.WindowsCommand()
	}
	if len(os.Args) != 2 {
		return errors.New("unsupported helper command")
	}
	if os.Args[1] == "user-sid" {
		value, err := winnet.Command("user-sid", nil)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(value)
	}
	if os.Args[1] == "dns-lease" {
		return splitdns.Lease()
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
		value, err := winnet.Command(os.Args[1], data)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(value)
	case "authorize-desktop":
		var request struct {
			Command     string `json:"command"`
			Certificate string `json:"certificate"`
		}
		if err = protocol.Decode(data, &request); err != nil {
			return err
		}
		if request.Command == "" || strings.ContainsRune(request.Command, 0) {
			return errors.New("invalid desktop setup command")
		}
		var cert *x509.Certificate
		if request.Certificate != "" {
			raw, _ := json.Marshal(request.Certificate)
			if cert, err = certs.Parse(raw); err != nil {
				return err
			}
			if err = valid(cert); err != nil {
				return err
			}
		}
		return setup.AuthorizeDesktop(request.Command, cert)
	case "trust-ca-privileged", "trust-ca-desktop", "untrust-ca-desktop", "remove-ca-privileged":
		cert, err := certs.Parse(data)
		if err != nil {
			return err
		}
		// Expired Fluxy roots must still be removable.
		if os.Args[1] == "remove-ca-privileged" {
			return certs.RemovePrivileged(cert)
		}
		if os.Args[1] == "untrust-ca-desktop" {
			return certs.RemoveTrustDesktop(cert)
		}
		if err = valid(cert); err != nil {
			return err
		}
		if os.Args[1] == "trust-ca-desktop" {
			return certs.TrustDesktop(cert)
		}
		return certs.TrustPrivileged(cert)
	case "validate-tun":
		var p tun.Params
		if err = protocol.Decode(data, &p); err != nil {
			return err
		}
		if err = p.Validate(); err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(tun.Config(p))
	case "validate-ca":
		raw, _ := json.Marshal(string(data))
		if _, err = certs.Parse(raw); err != nil {
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
