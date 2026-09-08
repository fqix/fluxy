package main

/*
#cgo CFLAGS: -Wno-deprecated-declarations
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <bsm/audit.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <stdlib.h>

// Security.framework binds the live caller to its audit token (including PID
// generation). Keep this native check while all service/RPC logic lives in Go.
static int fluxy_peer(int fd, unsigned int expected_uid, const char *path, const char *team) {
 uid_t uid; gid_t gid;
 if (getpeereid(fd, &uid, &gid) || uid != expected_uid) return 0;
 audit_token_t audit; socklen_t size = sizeof(audit);
 if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &audit, &size)) return 0;
 CFDataRef token = CFDataCreate(NULL, (UInt8*)&audit, sizeof(audit));
 const void *keys[] = { kSecGuestAttributeAudit }, *values[] = { token };
 CFDictionaryRef attrs = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
 SecCodeRef code = NULL; SecStaticCodeRef static_code = NULL; CFDictionaryRef info = NULL;
 CFStringRef expected_path = CFStringCreateWithCString(NULL, path, kCFStringEncodingUTF8);
 CFStringRef expected_team = CFStringCreateWithCString(NULL, team, kCFStringEncodingUTF8);
 CFStringRef actual_path = NULL;
 int valid = 0;
 if (SecCodeCopyGuestWithAttributes(NULL, attrs, kSecCSDefaultFlags, &code)) goto cleanup;
 if (SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &static_code)) goto cleanup;
 if (SecCodeCopySigningInformation(static_code, kSecCSSigningInformation, &info)) goto cleanup;
 CFURLRef executable = CFDictionaryGetValue(info, kSecCodeInfoMainExecutable);
 if (!executable) goto cleanup;
 actual_path = CFURLCopyFileSystemPath(executable, kCFURLPOSIXPathStyle);
 if (!actual_path || !CFEqual(actual_path, expected_path) || SecCodeCheckValidity(code, kSecCSDefaultFlags, NULL)) goto cleanup;
 if (*team) {
  CFStringRef actual_team = CFDictionaryGetValue(info, kSecCodeInfoTeamIdentifier);
  CFStringRef identifier = CFDictionaryGetValue(info, kSecCodeInfoIdentifier);
  if (!actual_team || !CFEqual(actual_team, expected_team) || !identifier || !CFEqual(identifier, CFSTR("dev.fengqi.fluxy.electron"))) goto cleanup;
  if (SecStaticCodeCheckValidity(static_code, kSecCSStrictValidate | kSecCSCheckNestedCode, NULL)) goto cleanup;
 }
 valid = 1;
cleanup:
 if (actual_path) CFRelease(actual_path);
 if (info) CFRelease(info);
 if (static_code) CFRelease(static_code);
 if (code) CFRelease(code);
 CFRelease(expected_path); CFRelease(expected_team); CFRelease(attrs); CFRelease(token);
 return valid;
}
static int fluxy_remove_admin_trust(const void *bytes, long size) {
 CFDataRef data = CFDataCreate(NULL, bytes, size);
 SecCertificateRef cert = SecCertificateCreateWithData(NULL, data);
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
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

func platformMain() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return run(ctx)
}
func platformEnv() []string {
	return []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HOME=/var/root", "LC_ALL=C"}
}
func secureBase() (string, error) {
	if helperTesting {
		if os.Geteuid() == 0 {
			return "", errors.New("test helper must never run as root")
		}
		return os.Getenv("FLUXY_HELPER_TEST_ROOT"), nil
	}
	base := "/Library/PrivilegedHelperTools/" + serviceID
	if os.Geteuid() != 0 {
		return "", errors.New("helper must be installed as a launchd service")
	}
	for _, path := range []string{base, filepath.Join(base, "pairing.json"), filepath.Join(base, "fluxy-core"), filepath.Join(base, "fluxy-helper")} {
		st, err := os.Lstat(path)
		if err != nil {
			return "", err
		}
		if st.Mode()&os.ModeSymlink != 0 || st.Mode().Perm()&0022 != 0 || st.Sys().(*syscall.Stat_t).Uid != 0 {
			return "", errors.New("unsafe helper installation")
		}
	}
	return base, nil
}

type lockedListener struct {
	net.Listener
	lock *os.File
}

func (l *lockedListener) Release() { _ = l.lock.Close() }
func listen(p pairing) (net.Listener, error) {
	base, err := secureBase()
	if err != nil {
		return nil, err
	}
	socket := "/private/var/run/" + serviceID + ".sock"
	if helperTesting {
		socket = filepath.Join(base, "helper.sock")
	}
	lock, err := os.OpenFile(filepath.Join(base, "daemon.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	if err = unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		lock.Close()
		return nil, errors.New("previous helper is still stopping")
	}
	fail := func(err error) (net.Listener, error) { lock.Close(); return nil, err }
	if err = os.Remove(socket); err != nil && !os.IsNotExist(err) {
		return fail(err)
	}
	l, err := net.Listen("unix", socket)
	if err != nil {
		return fail(err)
	}
	if err = os.Chown(socket, p.UID, -1); err == nil {
		err = os.Chmod(socket, 0600)
	}
	if err != nil {
		l.Close()
		return fail(err)
	}
	return &lockedListener{Listener: l, lock: lock}, nil
}
func peerAllowed(c net.Conn, p pairing) bool {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return false
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return false
	}
	path := C.CString(p.Caller.Path)
	defer C.free(unsafe.Pointer(path))
	teamID := ""
	if p.Caller.TeamID != nil {
		teamID = *p.Caller.TeamID
	}
	team := C.CString(teamID)
	defer C.free(unsafe.Pointer(team))
	valid := false
	if raw.Control(func(fd uintptr) { valid = C.fluxy_peer(C.int(fd), C.uint(p.UID), path, team) == 1 }) != nil || !valid {
		return false
	}
	if teamID != "" {
		return true
	}
	return verifyCaller(p.Caller.Path, p)
}
func containChild(*exec.Cmd) (func(), error) { return func() {}, nil }
func trustCertificate(cert *x509.Certificate, install bool, base string) error {
	if helperTesting {
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
		cmd.Env = platformEnv()
		output, err := cmd.CombinedOutput()
		return certificateCommandError(args[0], output, err)
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
func certificateCommandError(operation string, output []byte, err error) error {
	if err == nil {
		return nil
	}
	detail := strings.TrimSpace(string(output))
	if len(detail) > 4096 {
		detail = detail[:4096]
	}
	return fmt.Errorf("security %s: %w: %s", operation, err, detail)
}
