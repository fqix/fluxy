package certs

import (
	"bytes"
	"crypto/x509"
	"errors"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func Trust(cert *x509.Certificate, install bool, base string) error {
	name, _ := windows.UTF16PtrFromString("ROOT")
	store, err := windows.CertOpenStore(windows.CERT_STORE_PROV_SYSTEM_W, 0, 0, windows.CERT_SYSTEM_STORE_LOCAL_MACHINE|windows.CERT_STORE_OPEN_EXISTING_FLAG, uintptr(unsafe.Pointer(name)))
	if err != nil {
		return err
	}
	defer windows.CertCloseStore(store, 0)
	return updateStore(store, cert.Raw, install)
}
func updateStore(store windows.Handle, raw []byte, install bool) error {
	if len(raw) == 0 {
		return errors.New("empty certificate")
	}
	if install {
		cert, err := windows.CertCreateCertificateContext(windows.X509_ASN_ENCODING, &raw[0], uint32(len(raw)))
		if err != nil {
			return err
		}
		defer windows.CertFreeCertificateContext(cert)
		return windows.CertAddCertificateContextToStore(store, cert, windows.CERT_STORE_ADD_REPLACE_EXISTING, nil)
	}
	var previous *windows.CertContext
	for {
		cert, err := windows.CertEnumCertificatesInStore(store, previous)
		if err != nil {
			if errors.Is(err, syscall.Errno(windows.CRYPT_E_NOT_FOUND)) {
				return nil
			}
			return err
		}
		previous = cert
		if bytes.Equal(unsafe.Slice(cert.EncodedCert, cert.Length), raw) {
			duplicate := windows.CertDuplicateCertificateContext(cert)
			if err = windows.CertDeleteCertificateFromStore(duplicate); err != nil {
				windows.CertFreeCertificateContext(cert)
				return err
			}
		}
	}
}
