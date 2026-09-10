//go:build !darwin

package setup

import (
	"crypto/x509"
	"errors"
)

func AuthorizeDesktop(string, *x509.Certificate) error {
	return errors.New("native desktop authorization is only supported on macOS")
}
