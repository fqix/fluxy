package protocol

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCallerHashPin(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app")
	if err := os.WriteFile(path, []byte("expected"), 0600); err != nil {
		t.Fatal(err)
	}
	p := Pairing{}
	p.Caller.Path = path
	p.Caller.SHA256, _ = FileHash(path)
	if !VerifyCaller(path, p) {
		t.Fatal("expected caller rejected")
	}
	if err := os.WriteFile(path, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if VerifyCaller(path, p) {
		t.Fatal("changed executable accepted")
	}
}
