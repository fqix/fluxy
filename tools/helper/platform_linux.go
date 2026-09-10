package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const linuxBase = "/usr/local/lib/fluxy-helper"

func platformMain() error {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer cancel()
	return run(ctx)
}
func platformEnv() []string {
	return []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root", "LANG=C"}
}
func secureBase() (string, error) {
	if os.Geteuid() != 0 {
		return "", errors.New("helper must run as root")
	}
	for _, path := range []string{"/usr/local", "/usr/local/lib", linuxBase, filepath.Join(linuxBase, "pairing.json"), filepath.Join(linuxBase, "sing-box"), filepath.Join(linuxBase, "fluxy-helper")} {
		st, err := os.Lstat(path)
		if err != nil {
			return "", err
		}
		if st.Mode()&os.ModeSymlink != 0 || st.Mode().Perm()&0022 != 0 || st.Sys().(*syscall.Stat_t).Uid != 0 {
			return "", errors.New("unsafe helper installation")
		}
	}
	return linuxBase, nil
}
func listen(p pairing) (net.Listener, error) {
	if p.UID <= 0 {
		return nil, errors.New("pairing requires a desktop user")
	}
	dir := "/run/" + serviceID
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}
	path := dir + "/helper.sock"
	// systemd guarantees one process; the private root-owned directory prevents replacement.
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	l, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, err
	}
	if err = os.Chown(path, p.UID, -1); err == nil {
		err = os.Chmod(path, 0600)
	}
	if err != nil {
		l.Close()
		return nil, err
	}
	return l, nil
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
	var cred *unix.Ucred
	var inner error
	if raw.Control(func(fd uintptr) { cred, inner = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED) }) != nil || inner != nil || cred == nil || int(cred.Uid) != p.UID {
		return false
	}
	path, err := os.Readlink("/proc/" + strconv.Itoa(int(cred.Pid)) + "/exe")
	return err == nil && verifyCaller(path, p)
}
func containChild(cmd *exec.Cmd) (func(), error) { return func() {}, nil } // inherited stdin closes if the helper dies
func trustCertificate(cert *x509.Certificate, install bool, base string) error {
	var directory, tool string
	var args []string
	if _, err := os.Stat("/usr/sbin/update-ca-certificates"); err == nil {
		directory = "/usr/local/share/ca-certificates"
		tool = "/usr/sbin/update-ca-certificates"
	} else if _, err := os.Stat("/usr/bin/update-ca-trust"); err == nil {
		directory = "/etc/pki/ca-trust/source/anchors"
		tool = "/usr/bin/update-ca-trust"
		args = []string{"extract"}
	} else {
		return errors.New("supported system CA store not found (install ca-certificates)")
	}
	sum := sha256.Sum256(cert.Raw)
	path := filepath.Join(directory, "fluxy-"+hex.EncodeToString(sum[:])+".crt")
	if install {
		if err := writePublicCertificate(path, cert); err != nil {
			return err
		}
	} else {
		data, err := os.ReadFile(path)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if err == nil {
			block, _ := pem.Decode(data)
			if block == nil || !bytes.Equal(block.Bytes, cert.Raw) {
				return errors.New("installed certificate does not match")
			}
			if err = os.Remove(path); err != nil {
				return err
			}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, tool, args...)
	cmd.Env = platformEnv()
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("refresh system trust: %w", err)
	}
	return nil
}
