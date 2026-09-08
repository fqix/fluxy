//go:build !darwin

package main

import (
	"crypto/x509"
	"errors"
)

func authorizeDesktop(string, *x509.Certificate) error {
	return errors.New("native desktop authorization is only supported on macOS")
}
