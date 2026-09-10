// Package certs parses the Fluxy root CA and owns every platform trust-store
// change the helper is allowed to make.
package certs

import (
	"bytes"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"

	"dev.fengqi.fluxy/helper/internal/protocol"
)

// Parse accepts only a self-signed Fluxy root CA, never an arbitrary anchor.
func Parse(data json.RawMessage) (*x509.Certificate, error) {
	var encoded string
	if err := protocol.Decode(data, &encoded); err != nil || len(encoded) > 24000 {
		return nil, errors.New("invalid certificate")
	}
	der, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(der) > 16384 {
		return nil, errors.New("invalid certificate")
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	if !cert.IsCA || cert.Subject.CommonName != "Fluxy Electron Root CA" || !bytes.Equal(cert.RawSubject, cert.RawIssuer) || cert.CheckSignatureFrom(cert) != nil {
		return nil, errors.New("expected self-signed Fluxy root CA")
	}
	return cert, nil
}
