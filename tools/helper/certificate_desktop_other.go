//go:build !darwin

package main

import (
	"crypto/x509"
	"errors"
)

func addPublicCertificate(*x509.Certificate) error {
	return errors.New("separate public CA insertion is only supported on macOS")
}
func desktopTrustCertificate(*x509.Certificate) error {
	return errors.New("desktop CA trust is only supported on macOS")
}
