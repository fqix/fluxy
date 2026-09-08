package main

/*
#cgo CFLAGS: -Wno-deprecated-declarations
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#include <Security/Security.h>
#include <Security/AuthSession.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>

static OSStatus fluxy_add_public_ca(const void *bytes, long size) {
 CFDataRef data = CFDataCreate(NULL, bytes, size);
 SecCertificateRef cert = SecCertificateCreateWithData(NULL, data);
 SecKeychainRef keychain = NULL;
 OSStatus status = cert ? SecKeychainOpen("/Library/Keychains/System.keychain", &keychain) : errSecDecode;
 if (!status) status = SecCertificateAddToKeychain(cert, keychain);
 if (status == errSecDuplicateItem) status = errSecSuccess;
 if (keychain) CFRelease(keychain);
 if (cert) CFRelease(cert);
 CFRelease(data);
 return status;
}
static OSStatus fluxy_desktop_trust_ca(const void *bytes, long size) {
 SecuritySessionId session;
 SessionAttributeBits attributes;
 OSStatus status = SessionGetInfo(callerSecuritySession, &session, &attributes);
 if (status) return status;
 if (!(attributes & sessionHasGraphicAccess)) return errAuthorizationInteractionNotAllowed;
 CFDataRef data = CFDataCreate(NULL, bytes, size);
 SecCertificateRef cert = SecCertificateCreateWithData(NULL, data);
 status = cert ? SecTrustSettingsSetTrustSettings(cert, kSecTrustSettingsDomainAdmin, NULL) : errSecDecode;
 if (cert) CFRelease(cert);
 CFRelease(data);
 return status;
}
*/
import "C"

import (
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"runtime"
)

func addPublicCertificate(cert *x509.Certificate) error {
	if helperTesting {
		return errors.New("CA mutations are disabled in the rootless test helper")
	}
	if os.Geteuid() != 0 {
		return errors.New("system certificate insertion requires the privileged helper")
	}
	data := C.CBytes(cert.Raw)
	defer C.free(data)
	if status := C.fluxy_add_public_ca(data, C.long(len(cert.Raw))); status != 0 {
		return fmt.Errorf("add public certificate to System keychain: OSStatus %d", status)
	}
	return nil
}

func desktopTrustCertificate(cert *x509.Certificate) error {
	if helperTesting {
		return errors.New("CA mutations are disabled in the rootless test helper")
	}
	if os.Geteuid() == 0 {
		return errors.New("certificate trust must run in the desktop user session, not as root")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	data := C.CBytes(cert.Raw)
	defer C.free(data)
	status := C.fluxy_desktop_trust_ca(data, C.long(len(cert.Raw)))
	switch status {
	case 0:
		return nil
	case -60006, -128:
		return errors.New("Certificate trust authorization canceled. Helper remains installed; retry Complete Setup")
	case -60007:
		return errors.New("Certificate trust requires an interactive macOS desktop session. Open Fluxy in your logged-in desktop and retry Complete Setup")
	default:
		return fmt.Errorf("macOS certificate trust authorization failed: OSStatus %d", status)
	}
}
