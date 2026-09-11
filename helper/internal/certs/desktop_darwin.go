package certs

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
static OSStatus fluxy_privileged_trust_ca(const void *bytes, long size) {
 OSStatus status = fluxy_add_public_ca(bytes, size);
 if (status) return status;
 CFDataRef data = CFDataCreate(NULL, bytes, size);
 SecCertificateRef cert = SecCertificateCreateWithData(NULL, data);
 CFRelease(data);
 if (!cert) return errSecDecode;
 CFArrayRef settings = NULL;
 status = SecTrustSettingsCopyTrustSettings(cert, kSecTrustSettingsDomainAdmin, &settings);
 Boolean trusted = !status && settings && CFArrayGetCount(settings) == 0;
 if (settings) CFRelease(settings);
 if (status && status != errSecItemNotFound) { CFRelease(cert); return status; }
 if (!trusted) status = SecTrustSettingsSetTrustSettings(cert, kSecTrustSettingsDomainAdmin, NULL);
 if (!status) {
  settings = NULL;
  status = SecTrustSettingsCopyTrustSettings(cert, kSecTrustSettingsDomainAdmin, &settings);
  if (!status && (!settings || CFArrayGetCount(settings) != 0)) status = errSecNotTrusted;
  if (settings) CFRelease(settings);
 }
 CFRelease(cert);
 return status;
}
// A certificate built from DER is not a keychain item, so SecItemDelete rejects it
// as kSecValueRef with errSecInvalidItemRef. Match the login keychain's own item by
// exact DER and delete that, leaving every other certificate untouched.
static OSStatus fluxy_delete_login_ca(SecCertificateRef cert) {
 CFDataRef expected = SecCertificateCopyData(cert);
 if (!expected) return errSecDecode;
 SecKeychainRef keychain = NULL;
 OSStatus status = SecKeychainCopyDefault(&keychain);
 if (status) { CFRelease(expected); return status; }
 CFArrayRef search = CFArrayCreate(NULL, (const void**)&keychain, 1, &kCFTypeArrayCallBacks);
 const void *keys[] = {kSecClass, kSecMatchSearchList, kSecMatchLimit, kSecReturnRef};
 const void *values[] = {kSecClassCertificate, search, kSecMatchLimitAll, kCFBooleanTrue};
 CFDictionaryRef query = CFDictionaryCreate(NULL, keys, values, 4, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
 CFTypeRef result = NULL;
 status = SecItemCopyMatching(query, &result);
 if (status == errSecItemNotFound) status = errSecSuccess;
 else if (!status && result && CFGetTypeID(result) == CFArrayGetTypeID()) {
  CFArrayRef items = (CFArrayRef)result;
  for (CFIndex i = 0; i < CFArrayGetCount(items) && !status; i++) {
   SecCertificateRef found = (SecCertificateRef)CFArrayGetValueAtIndex(items, i);
   CFDataRef der = SecCertificateCopyData(found);
   if (der && CFEqual(der, expected)) {
    status = SecKeychainItemDelete((SecKeychainItemRef)found);
    if (status == errSecItemNotFound) status = errSecSuccess;
   }
   if (der) CFRelease(der);
  }
 }
 if (result) CFRelease(result);
 CFRelease(query); CFRelease(search); CFRelease(keychain); CFRelease(expected);
 return status;
}
// Admin-domain trust settings are readable without privileges; only clearing them
// needs root. Reporting them directly avoids trusting a verify-cert answer that
// trustd may still serve from cache right after the user-domain removal.
static int fluxy_admin_trust_exists(SecCertificateRef cert) {
 CFArrayRef settings = NULL;
 OSStatus status = SecTrustSettingsCopyTrustSettings(cert, kSecTrustSettingsDomainAdmin, &settings);
 if (settings) CFRelease(settings);
 if (status == errSecSuccess) return 1;
 if (status == errSecItemNotFound || status == errSecNoTrustSettings) return 0;
 return -1;
}
// The desktop session owns only what it installed: user-domain trust settings and
// the login keychain copy. Admin-domain trust from an older release still needs
// the elevated remove-ca-privileged path.
static int fluxy_remove_desktop_trust(const void *bytes, long size, int *admin) {
 SecuritySessionId session;
 SessionAttributeBits attributes;
 OSStatus status = SessionGetInfo(callerSecuritySession, &session, &attributes);
 if (status) return status;
 if (!(attributes & sessionHasGraphicAccess)) return errAuthorizationInteractionNotAllowed;
 CFDataRef data = CFDataCreate(NULL, bytes, size);
 SecCertificateRef cert = SecCertificateCreateWithData(NULL, data);
 CFRelease(data);
 if (!cert) return errSecDecode;
 CFArrayRef settings = NULL;
 status = SecTrustSettingsCopyTrustSettings(cert, kSecTrustSettingsDomainUser, &settings);
 if (settings) CFRelease(settings);
 if (status == errSecSuccess) {
  status = SecTrustSettingsRemoveTrustSettings(cert, kSecTrustSettingsDomainUser);
  if (status == errSecSuccess) {
   settings = NULL;
   status = SecTrustSettingsCopyTrustSettings(cert, kSecTrustSettingsDomainUser, &settings);
   if (settings) CFRelease(settings);
   if (status == errSecSuccess) status = errSecInternalComponent;
  }
 }
 if (status == errSecItemNotFound || status == errSecNoTrustSettings) status = errSecSuccess;
 if (status == errSecSuccess) status = fluxy_delete_login_ca(cert);
 if (status == errSecSuccess) {
  *admin = fluxy_admin_trust_exists(cert);
  if (*admin < 0) status = errSecInternalComponent;
 }
 CFRelease(cert);
 return status;
}
// One dialog, no elevation: the user trust domain is written by the logged-in
// user through com.apple.trust-settings.user, and the login keychain holds the
// certificate itself. The admin domain would additionally require root for the
// System keychain and authenticate-admin (allow-root false, timeout 0), which is
// a second, uncacheable dialog.
static OSStatus fluxy_add_login_ca(SecCertificateRef cert, Boolean *inserted) {
 SecKeychainRef keychain = NULL;
 OSStatus status = SecKeychainCopyDefault(&keychain);
 if (status) return status;
 status = SecCertificateAddToKeychain(cert, keychain);
 *inserted = status == errSecSuccess;
 if (status == errSecDuplicateItem) status = errSecSuccess;
 CFRelease(keychain);
 return status;
}
static OSStatus fluxy_user_trusted(SecCertificateRef cert, Boolean *trusted) {
 CFArrayRef settings = NULL;
 OSStatus status = SecTrustSettingsCopyTrustSettings(cert, kSecTrustSettingsDomainUser, &settings);
 // An empty settings array is the unrestricted "trust as root" record.
 *trusted = !status && settings && CFArrayGetCount(settings) == 0;
 if (settings) CFRelease(settings);
 if (status == errSecItemNotFound || status == errSecNoTrustSettings) status = errSecSuccess;
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
 CFRelease(data);
 if (!cert) return errSecDecode;
 Boolean trusted = false;
 Boolean inserted = false;
 status = fluxy_add_login_ca(cert, &inserted);
 if (!status) status = fluxy_user_trusted(cert, &trusted);
 // Never present a dialog for a setting that is already in place.
 if (!status && !trusted) status = SecTrustSettingsSetTrustSettings(cert, kSecTrustSettingsDomainUser, NULL);
 if (!status) {
  status = fluxy_user_trusted(cert, &trusted);
  if (!status && !trusted) status = errSecNotTrusted;
 }
 // A canceled or failed dialog must not leave the certificate behind.
 if (status && inserted) fluxy_delete_login_ca(cert);
 CFRelease(cert);
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

	"dev.fengqi.fluxy/helper/internal/protocol"
)

func AddPublic(cert *x509.Certificate) error {
	if protocol.Testing {
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

func TrustDesktop(cert *x509.Certificate) error {
	if protocol.Testing {
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
		return errors.New("Certificate installation authorization canceled; retry Install CA")
	case -61:
		return errors.New("Login keychain write denied (OSStatus -61); unlock your login keychain and retry Install CA")
	case -60007:
		return errors.New("Certificate trust requires an interactive macOS desktop session. Open Fluxy in your logged-in desktop and retry Install CA")
	default:
		return fmt.Errorf("macOS certificate trust authorization failed: OSStatus %d", status)
	}
}

// Only called by the elevated installer CLI, never by the daemon RPC dispatcher.
func TrustPrivileged(cert *x509.Certificate) error {
	if protocol.Testing {
		return errors.New("CA mutations are disabled in the rootless test helper")
	}
	if os.Geteuid() != 0 {
		return errors.New("certificate installation requires the elevated installer")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	data := C.CBytes(cert.Raw)
	defer C.free(data)
	if status := C.fluxy_privileged_trust_ca(data, C.long(len(cert.Raw))); status != 0 {
		return fmt.Errorf("elevated certificate trust failed: OSStatus %d; Helper remains installed", status)
	}
	return nil
}

// RemoveTrustDesktop owns any authorization UI; the daemon only performs cleanup afterwards.
// RemoveTrustDesktop reports whether an admin-domain record, which only the
// elevated remove-ca-privileged path can clear, still trusts the certificate.
func RemoveTrustDesktop(cert *x509.Certificate) (adminTrust bool, err error) {
	if protocol.Testing {
		return false, errors.New("CA mutations are disabled in the rootless test helper")
	}
	if os.Geteuid() == 0 {
		return false, errors.New("certificate trust removal must run in the desktop user session, not as root")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	data := C.CBytes(cert.Raw)
	defer C.free(data)
	var admin C.int
	if err := removalAuthorizationError(int(C.fluxy_remove_desktop_trust(data, C.long(len(cert.Raw)), &admin))); err != nil {
		return false, err
	}
	return admin == 1, nil
}

func removalAuthorizationError(status int) error {
	switch status {
	case 0:
		return nil
	case -60006, -128:
		return errors.New("Certificate trust removal canceled; the certificate was not deleted")
	case -60007:
		return errors.New("Certificate trust removal requires an interactive macOS desktop session. Open Fluxy in your logged-in desktop and retry")
	default:
		return fmt.Errorf("macOS certificate trust removal failed: OSStatus %d; the certificate was not deleted", status)
	}
}
