package certs

import (
	"crypto/x509"
	"encoding/pem"
	"errors"
	"os"
)

func WritePublic(path string, cert *x509.Certificate) error {
	// The caller supplies a path in a root-owned system trust-store directory.
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return errors.New("unsafe CA path")
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw}), 0644); err != nil {
		return err
	}
	// The helper's UMask=0077 must not hide public trust anchors from desktop users.
	// Chmod also repairs certificates installed with mode 0600 by older helpers.
	return os.Chmod(path, 0644)
}
