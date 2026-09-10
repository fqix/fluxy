package setup

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"

	"dev.fengqi.fluxy/helper/internal/winnet"
	"golang.org/x/sys/windows"
)

func TestCertificateSetupValidation(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct {
		name       string
		expired    bool
		commonName string
	}{
		{"valid", false, "Fluxy Electron Root CA"},
		{"expired", true, "Fluxy Electron Root CA"},
		{"unrelated", false, "Other Root CA"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			until := time.Now().Add(time.Hour)
			if scenario.expired {
				until = time.Now().Add(-time.Hour)
			}
			template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: scenario.commonName}, NotBefore: time.Now().Add(-2 * time.Hour), NotAfter: until, IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
			der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
			if err != nil {
				t.Fatal(err)
			}
			for _, action := range []string{"install-certificate", "remove-certificate"} {
				r := setupRequest{Action: action, Certificate: base64.StdEncoding.EncodeToString(der)}
				wantValid := scenario.name != "unrelated" && (!scenario.expired || action == "remove-certificate")
				if (r.validate() == nil) != wantValid {
					t.Fatalf("unexpected validation for %s", action)
				}
				r.Stage = `C:\stage`
				if r.validate() == nil {
					t.Fatal("certificate operation accepted installer fields")
				}
			}
		})
	}
	for _, r := range []setupRequest{
		{Action: "install-certificate"}, {Action: "remove-certificate", Certificate: "bad"},
		{Action: "uninstall", Certificate: "unexpected"},
	} {
		if r.validate() == nil {
			t.Fatal("accepted invalid certificate request")
		}
	}
}

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
