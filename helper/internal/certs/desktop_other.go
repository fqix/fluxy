//go:build !darwin

package certs

import (
	"crypto/x509"
	"errors"
)

func AddPublic(*x509.Certificate) error {
	return errors.New("separate public CA insertion is only supported on macOS")
}
func TrustDesktop(*x509.Certificate) error {
	return errors.New("desktop CA trust is only supported on macOS")
}

func TrustPrivileged(*x509.Certificate) error {
	return errors.New("elevated native CA trust is only supported on macOS")
}

func RemoveTrustDesktop(*x509.Certificate) error {
	return errors.New("desktop CA trust removal is only supported on macOS")
}

func RemovePrivileged(*x509.Certificate) error {
	return errors.New("elevated native CA removal is only supported on macOS")
}
