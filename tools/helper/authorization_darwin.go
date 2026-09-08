package main

/*
#cgo CFLAGS: -Wno-deprecated-declarations
#cgo LDFLAGS: -framework Security
#include <Security/Security.h>
#include <Security/AuthSession.h>
#include <stdio.h>
#include <stdlib.h>
static OSStatus fluxy_authorize_shell(const char *command, AuthorizationRef *auth, FILE **pipe) {
 SecuritySessionId session; SessionAttributeBits attributes;
 OSStatus status = SessionGetInfo(callerSecuritySession, &session, &attributes);
 if (status) return status;
 if (!(attributes & sessionHasGraphicAccess)) return errAuthorizationInteractionNotAllowed;
 status = AuthorizationCreate(NULL, kAuthorizationEmptyEnvironment, kAuthorizationFlagDefaults, auth);
 if (status) return status;
 AuthorizationItem item = { kAuthorizationRightExecute, 0, NULL, 0 };
 AuthorizationRights rights = { 1, &item };
 status = AuthorizationCopyRights(*auth, &rights, kAuthorizationEmptyEnvironment,
   kAuthorizationFlagInteractionAllowed | kAuthorizationFlagExtendRights | kAuthorizationFlagPreAuthorize, NULL);
 if (status) return status;
 char *args[] = { "-c", (char*)command, NULL };
 return AuthorizationExecuteWithPrivileges(*auth, "/bin/sh", kAuthorizationFlagDefaults, args, pipe);
}
*/
import "C"

import (
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"unsafe"
)

// AuthorizationExecuteWithPrivileges is a compatibility bridge for the current
// manually installed launchd service and unsigned Electron development host.
// It is deprecated; SMAppService requires a separately packaged service migration.
// Never expose this desktop-only command through the privileged daemon's RPC.
func authorizeDesktop(command string, cert *x509.Certificate) error {
	if helperTesting {
		return errors.New("Desktop authorization is disabled in the rootless test helper")
	}
	if os.Geteuid() == 0 {
		return errors.New("desktop authorization must run as the logged-in user")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	command = nativeSetupCommand(command, cert)
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	marker := "FLUXY_AUTH_RESULT_" + hex.EncodeToString(nonce[:]) + ":"
	wrapped := "(\n" + command + "\n) 2>&1\nfluxy_result=$?\nprintf '\\n" + marker + "%d\\n' \"$fluxy_result\"\n"
	ccommand := C.CString(wrapped)
	defer C.free(unsafe.Pointer(ccommand))
	var auth C.AuthorizationRef
	var pipe *C.FILE
	status := C.fluxy_authorize_shell(ccommand, &auth, &pipe)
	if auth != nil {
		defer C.AuthorizationFree(auth, C.kAuthorizationFlagDefaults)
	}
	if status != 0 {
		return fmt.Errorf("Native helper authorization canceled or failed: OSStatus %d", status)
	}
	if pipe == nil {
		return errors.New("native installer did not return a result channel")
	}
	defer C.fclose(pipe)
	// Keep a bounded tail while draining the pipe so a verbose installer cannot block.
	var output []byte
	for {
		ch := C.fgetc(pipe)
		if ch == C.EOF {
			break
		}
		output = append(output, byte(ch))
		if len(output) > 32768 {
			output = append([]byte(nil), output[len(output)-16384:]...)
		}
	}
	if err := nativeInstallerResult(output, marker); err != nil {
		return err
	}
	return nil
}

func nativeInstallerResult(output []byte, marker string) error {
	result := strings.TrimSpace(string(output))
	index := strings.LastIndex(result, "\n"+marker)
	if index < 0 && strings.HasPrefix(result, marker) {
		index = 0
	} else if index >= 0 {
		index++
	}
	if index < 0 {
		return errors.New("native installer ended without a completion result: " + result)
	}
	if result[index:] != marker+"0" {
		return errors.New("native helper operation failed: " + result)
	}
	return nil
}

// The installed, checksum-verified helper completes certificate trust within the
// same elevated installation process. No second desktop authorizer is launched.
func nativeSetupCommand(command string, cert *x509.Certificate) string {
	if cert == nil {
		return command
	}
	encoded := base64.StdEncoding.EncodeToString(cert.Raw)
	return command + "\nfluxy_result=$?\n[ \"$fluxy_result\" -eq 0 ] || exit \"$fluxy_result\"\n" +
		"'/Library/PrivilegedHelperTools/" + serviceID + "/fluxy-helper' trust-ca-privileged <<'FLUXY_PUBLIC_CA'\n\"" +
		encoded + "\"\nFLUXY_PUBLIC_CA\n"
}
