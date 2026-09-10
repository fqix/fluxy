package certs

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"testing"
	"time"
)

func TestCertificateBoundary(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Fluxy Electron Root CA"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	check := func() error {
		der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
		if err != nil {
			return err
		}
		raw, _ := json.Marshal(base64.StdEncoding.EncodeToString(der))
		_, err = Parse(raw)
		return err
	}
	if err = check(); err != nil {
		t.Fatal(err)
	}
	cert.Subject.CommonName = "Other CA"
	if check() == nil {
		t.Fatal("accepted unrelated root")
	}
	cert.Subject.CommonName = "Fluxy Electron Root CA"
	cert.IsCA = false
	if check() == nil {
		t.Fatal("accepted leaf certificate")
	}
}
