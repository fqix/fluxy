package certs

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

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
		if err = updateStore(store, raw, true); err != nil {
			t.Fatal(err)
		}
	}
	if err = updateStore(store, own, false); err != nil {
		t.Fatal(err)
	}
	if err = updateStore(store, own, false); err != nil {
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
