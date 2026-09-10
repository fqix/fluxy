package certs

import (
	"crypto/x509"
	"errors"
	"os"
	"strings"
	"testing"
)

func TestCertificateCommandError(t *testing.T) {
	failure := errors.New("exit status 1")
	detail := "SecTrustSettingsSetTrustSettings: The authorization was denied since no user interaction was possible."
	err := commandError("add-trusted-cert", []byte(detail), failure)
	if !errors.Is(err, failure) || !strings.Contains(err.Error(), detail) || !strings.Contains(err.Error(), "add-trusted-cert") {
		t.Fatalf("lost diagnostic: %v", err)
	}
	if commandError("verify-cert", nil, nil) != nil {
		t.Fatal("success reported as failure")
	}
}

func TestRemovalAuthorizationError(t *testing.T) {
	for _, tc := range []struct {
		status int
		want   string
	}{
		{0, ""}, {-60006, "canceled"}, {-128, "canceled"},
		{-60007, "interactive macOS desktop session"}, {-50, "OSStatus -50"},
	} {
		err := removalAuthorizationError(tc.status)
		if tc.want == "" {
			if err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("status %d: %v", tc.status, err)
		}
	}
}

func TestRemovePrivilegedRejectsDesktopCaller(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("requires unprivileged caller")
	}
	if err := RemovePrivileged(&x509.Certificate{}); err == nil || !strings.Contains(err.Error(), "elevated uninstaller") {
		t.Fatalf("unexpected guard result: %v", err)
	}
}
