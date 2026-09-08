//go:build darwin || linux

package main

import (
	"crypto/x509"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestPublicCertificatePermissions(t *testing.T) {
	if os.Getenv("FLUXY_TEST_PUBLIC_CA") != "1" {
		// Match systemd's UMask=0077 in a child, without changing this test process.
		cmd := exec.Command(
			"/bin/sh",
			"-c",
			`umask 077; exec "$1" -test.run '^TestPublicCertificatePermissions$'`,
			"test",
			os.Args[0],
		)
		cmd.Env = append(os.Environ(), "FLUXY_TEST_PUBLIC_CA=1")
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("restricted-umask child: %v\n%s", err, output)
		}
		return
	}
	cert := &x509.Certificate{Raw: []byte("public certificate fixture")}
	for _, tc := range []struct {
		name     string
		existing bool
	}{
		{name: "new certificate"},
		{name: "repair existing private permissions", existing: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "root.crt")
			if tc.existing {
				if err := os.WriteFile(path, []byte("old certificate"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := writePublicCertificate(path, cert); err != nil {
				t.Fatal(err)
			}
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != 0644 {
				t.Errorf("public CA mode = %o, want 644", info.Mode().Perm())
			}
		})
	}
	directory := t.TempDir()
	private := filepath.Join(directory, "private-key")
	if err := os.WriteFile(private, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "symlink.crt")
	if err := os.Symlink(private, link); err != nil {
		t.Fatal(err)
	}
	if err := writePublicCertificate(link, cert); err == nil {
		t.Fatal("accepted symlink")
	}
	data, err := os.ReadFile(private)
	if err != nil || string(data) != "private" {
		t.Fatal("symlink target changed")
	}
}
