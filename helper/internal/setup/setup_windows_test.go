package setup

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"dev.fengqi.fluxy/helper/internal/winnet"
	"golang.org/x/sys/windows"
)

func TestNativeSetupValidation(t *testing.T) {
	hash := strings.Repeat("a", 64)
	valid := setupRequest{Action: "install", Stage: `C:\Users\测试 name's & data\stage`, HelperSHA256: hash, CoreSHA256: hash, PairingSHA256: hash}
	if err := valid.validate(); err != nil {
		t.Fatal(err)
	}
	for _, r := range []setupRequest{{Action: "command"}, {Action: "uninstall", Stage: `C:\Windows`}, {Action: "install", Stage: "relative", HelperSHA256: hash, CoreSHA256: hash, PairingSHA256: hash}, {Action: "install", Stage: valid.Stage, HelperSHA256: "bad", CoreSHA256: hash, PairingSHA256: hash}} {
		if r.validate() == nil {
			t.Fatalf("accepted invalid request: %+v", r)
		}
	}
	if (setupRequest{Action: "uninstall"}).validate() != nil {
		t.Fatal("uninstall rejected")
	}
}
func TestPinnedSetupCopy(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	dest := filepath.Join(root, "dest")
	data := []byte("verified payload")
	if err := os.WriteFile(source, data, 0600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	if err := copyPinned(source, dest, hex.EncodeToString(sum[:])); err != nil {
		t.Fatal(err)
	}
	if err := copyPinned(source, dest, hex.EncodeToString(sum[:])); err == nil {
		t.Fatal("overwrote existing destination")
	}
	if err := copyPinned(source, filepath.Join(root, "bad"), strings.Repeat("0", 64)); err == nil {
		t.Fatal("accepted checksum mismatch")
	}
	if checkSetupPath(root, filepath.Join(root, "..", "outside")) == nil {
		t.Fatal("accepted path outside root")
	}
	if checkSetupPath(root, source) == nil {
		t.Fatal("accepted file as install directory")
	}
}
func TestNativeUserSIDAndShellExecuteLayout(t *testing.T) {
	sid, err := winnet.SID()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = windows.StringToSid(sid); err != nil {
		t.Fatal(err)
	}
	if unsafe.Sizeof(uintptr(0)) == 8 && unsafe.Sizeof(shellExecuteInfo{}) != 112 {
		t.Fatal("incorrect SHELLEXECUTEINFOW layout")
	}
}
