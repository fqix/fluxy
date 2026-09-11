package platform

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
*/
import "C"

import (
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"

	"dev.fengqi.fluxy/helper/internal/protocol"
	"golang.org/x/sys/unix"
)

func Env() []string {
	return []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HOME=/var/root", "LC_ALL=C"}
}
func SecureBase() (string, error) {
	if protocol.Testing {
		if os.Geteuid() == 0 {
			return "", errors.New("test helper must never run as root")
		}
		return os.Getenv("FLUXY_HELPER_TEST_ROOT"), nil
	}
	base := "/Library/Application Support/" + protocol.ServiceID
	if os.Geteuid() != 0 {
		return "", errors.New("helper must be installed as a launchd service")
	}
	// The executable is the single file launchd runs from /Library/PrivilegedHelperTools;
	// the core and pairing live in the root-only support directory.
	for _, path := range []string{"/Library/PrivilegedHelperTools/" + protocol.ServiceID, base, filepath.Join(base, "pairing.json"), filepath.Join(base, "sing-box")} {
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
func Listen(p protocol.Pairing) (net.Listener, error) {
	base, err := SecureBase()
	if err != nil {
		return nil, err
	}
	socket := "/private/var/run/" + protocol.ServiceID + ".sock"
	if protocol.Testing {
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
func PeerAllowed(c net.Conn, p protocol.Pairing) bool {
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
	return protocol.VerifyCaller(p.Caller.Path, p)
}
func ContainChild(*exec.Cmd) (func(), error) { return func() {}, nil }
