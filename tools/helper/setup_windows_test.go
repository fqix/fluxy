package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"

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
func TestNativeCertificateExactRemoval(t *testing.T) {
	// An in-memory certificate store exercises Crypt32 without changing trust.
	store, err := windows.CertOpenStore(windows.CERT_STORE_PROV_MEMORY, 0, 0, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CertCloseStore(store, 0)
	create := func(serial int64) []byte {
		key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if e != nil {
			t.Fatal(e)
		}
		template := &x509.Certificate{SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: "Same display name"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
		der, e := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
		if e != nil {
			t.Fatal(e)
		}
		return der
	}
	own, other := create(1), create(2)
	for _, raw := range [][]byte{own, other, own} {
		if err = updateCertificateStore(store, raw, true); err != nil {
			t.Fatal(err)
		}
	}
	if err = updateCertificateStore(store, own, false); err != nil {
		t.Fatal(err)
	}
	if err = updateCertificateStore(store, own, false); err != nil {
		t.Fatal(err)
	}
	cert, err := windows.CertEnumCertificatesInStore(store, nil)
	if err != nil {
		t.Fatal(err)
	}
	got := append([]byte(nil), unsafe.Slice(cert.EncodedCert, cert.Length)...)
	if string(got) != string(other) {
		windows.CertFreeCertificateContext(cert)
		t.Fatal("deleted unrelated certificate")
	}
	if extra, _ := windows.CertEnumCertificatesInStore(store, cert); extra != nil {
		windows.CertFreeCertificateContext(extra)
		t.Fatal("duplicate certificate remains")
	}
}
func TestNativeUserSIDAndShellExecuteLayout(t *testing.T) {
	sid, err := nativeSID()
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
