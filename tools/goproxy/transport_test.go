package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"testing"
	"time"
)

func TestUpstreamTLS(t *testing.T) {
	t.Parallel()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "fixture"},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	cert, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert})
	for _, tc := range []struct {
		name    string
		ca      any
		invalid bool
	}{
		{name: "system roots"},
		{name: "PEM string", ca: string(ca)},
		{name: "Node Buffer", ca: wireBytes(ca)},
		{name: "certificate array", ca: []any{string(ca), wireBytes(ca)}},
		{name: "invalid CA", ca: "not a certificate", invalid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			value, err := json.Marshal(tc.ca)
			if err != nil {
				t.Fatal(err)
			}
			config, err := upstreamTLS(requestOptions{CA: value})
			if tc.invalid {
				if err == nil {
					t.Fatal("accepted invalid CA")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if config.InsecureSkipVerify || config.MinVersion < tls.VersionTLS12 {
				t.Fatal("upstream verification disabled")
			}
			if tc.ca == nil && config.RootCAs != nil {
				t.Fatal("default system roots were replaced")
			}
		})
	}
}
