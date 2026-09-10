package platform

import (
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"

	"dev.fengqi.fluxy/helper/internal/protocol"
	"golang.org/x/sys/unix"
)

const linuxBase = "/usr/local/lib/fluxy-helper"

func Env() []string {
	return []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root", "LANG=C"}
}
func SecureBase() (string, error) {
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
func Listen(p protocol.Pairing) (net.Listener, error) {
	if p.UID <= 0 {
		return nil, errors.New("pairing requires a desktop user")
	}
	dir := "/run/" + protocol.ServiceID
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
func PeerAllowed(c net.Conn, p protocol.Pairing) bool {
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
	return err == nil && protocol.VerifyCaller(path, p)
}
func ContainChild(cmd *exec.Cmd) (func(), error) { return func() {}, nil } // inherited stdin closes if the helper dies
