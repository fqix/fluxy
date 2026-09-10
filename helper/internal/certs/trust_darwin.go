package certs

/*
#cgo CFLAGS: -Wno-deprecated-declarations
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#include <Security/Security.h>
#include <Security/AuthSession.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>

static int fluxy_remove_admin_trust(const void *bytes, long size) {
 CFDataRef data = CFDataCreate(NULL, bytes, size);
 SecCertificateRef cert = SecCertificateCreateWithData(NULL, data);
 if (!cert) { CFRelease(data); return errSecDecode; }
 CFArrayRef trust = NULL;
 OSStatus status = SecTrustSettingsCopyTrustSettings(cert, kSecTrustSettingsDomainAdmin, &trust);
 if (trust) CFRelease(trust);
 if (status == errSecSuccess) {
  status = SecTrustSettingsRemoveTrustSettings(cert, kSecTrustSettingsDomainAdmin);
  if (status == errSecSuccess) {
   trust = NULL;
   status = SecTrustSettingsCopyTrustSettings(cert, kSecTrustSettingsDomainAdmin, &trust);
   if (trust) CFRelease(trust);
   if (status == errSecSuccess) status = errSecInternalComponent;
  }
 }
 if (status == errSecItemNotFound || status == errSecNoTrustSettings) status = errSecSuccess;
 CFRelease(cert); CFRelease(data);
 return status;
}
static int fluxy_cert_installed(const void *bytes, long size) {
 SecKeychainRef keychain = NULL; CFTypeRef result = NULL;
 OSStatus status = SecKeychainOpen("/Library/Keychains/System.keychain", &keychain);
 if (status) return -1;
 CFArrayRef search = CFArrayCreate(NULL, (const void**)&keychain, 1, &kCFTypeArrayCallBacks);
 const void *keys[] = {kSecClass,kSecMatchSearchList,kSecMatchLimit,kSecReturnRef};
 const void *values[] = {kSecClassCertificate,search,kSecMatchLimitAll,kCFBooleanTrue};
 CFDictionaryRef query = CFDictionaryCreate(NULL, keys, values, 4, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
 status = SecItemCopyMatching(query, &result);
 CFDataRef expected = CFDataCreate(NULL, bytes, size);
 int found = status == errSecItemNotFound ? 0 : -1;
 if (!status && result && CFGetTypeID(result) == CFArrayGetTypeID()) {
  found = 0;
  CFArrayRef certs = (CFArrayRef)result;
  for (CFIndex i = 0; i < CFArrayGetCount(certs); i++) {
   CFDataRef der = SecCertificateCopyData((SecCertificateRef)CFArrayGetValueAtIndex(certs,i));
   if (CFEqual(der,expected)) found = 1;
   CFRelease(der);
  }
 }
 CFRelease(expected); if (result) CFRelease(result); CFRelease(query); CFRelease(search); CFRelease(keychain);
 return found;
}
*/
import "C"

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"dev.fengqi.fluxy/helper/internal/platform"
	"dev.fengqi.fluxy/helper/internal/protocol"
)

func Trust(cert *x509.Certificate, install bool, base string) error {
	if protocol.Testing {
		return errors.New("CA mutations are disabled in the rootless test helper")
	}
	path := filepath.Join(base, "certificate.der")
	if err := os.WriteFile(path, cert.Raw, 0600); err != nil {
		return err
	}
	defer os.Remove(path)
	execute := func(args ...string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "/usr/bin/security", args...)
		cmd.Env = platform.Env()
		output, err := cmd.CombinedOutput()
		return commandError(args[0], output, err)
	}
	if install {
		if execute("verify-cert", "-c", path, "-p", "basic", "-l", "-L") == nil {
			return nil
		}
		if err := execute("add-trusted-cert", "-d", "-r", "trustRoot", "-k", "/Library/Keychains/System.keychain", path); err != nil {
			return err
		}
		return execute("verify-cert", "-c", path, "-p", "basic", "-l", "-L")
	}
	data := C.CBytes(cert.Raw)
	defer C.free(data)
	if status := C.fluxy_remove_admin_trust(data, C.long(len(cert.Raw))); status != 0 {
		return fmt.Errorf("remove admin trust: %d", status)
	}
	installed := C.fluxy_cert_installed(data, C.long(len(cert.Raw)))
	if installed < 0 {
		return errors.New("could not inspect System certificates")
	}
	if installed == 0 {
		return nil
	}
	hash := sha256.Sum256(cert.Raw)
	if err := execute("delete-certificate", "-Z", hex.EncodeToString(hash[:]), "/Library/Keychains/System.keychain"); err != nil {
		return err
	}
	if C.fluxy_cert_installed(data, C.long(len(cert.Raw))) != 0 {
		return errors.New("certificate remains installed")
	}
	return nil
}

// Preserve security diagnostics instead of exposing only an exit status to the UI.
func commandError(operation string, output []byte, err error) error {
	if err == nil {
		return nil
	}
	detail := strings.TrimSpace(string(output))
	if len(detail) > 4096 {
		detail = detail[:4096]
	}
	return fmt.Errorf("security %s: %w: %s", operation, err, detail)
}

// RemovePrivileged runs only inside the desktop-authorized uninstaller, not launchd.
func RemovePrivileged(cert *x509.Certificate) error {
	if protocol.Testing {
		return errors.New("CA mutations are disabled in the rootless test helper")
	}
	if os.Geteuid() != 0 {
		return errors.New("certificate removal requires the elevated uninstaller")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	directory, err := os.MkdirTemp("", "fluxy-ca-remove-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	return Trust(cert, false, directory)
}
