package main

import (
	"bytes"
	"context"
	"crypto/x509"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

func platformEnv() []string {
	root, _ := windows.GetWindowsDirectory()
	return []string{"SystemRoot=" + root, "WINDIR=" + root, "PATH=" + filepath.Join(root, "System32"), "TEMP=" + os.TempDir()}
}
func secureBase() (string, error) {
	base, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	if err != nil {
		return "", err
	}
	base = filepath.Join(base, "FluxyHelper")
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if !windows.GetCurrentProcessToken().IsElevated() || !strings.EqualFold(filepath.Dir(exe), base) {
		return "", errors.New("helper requires its protected service installation")
	}
	return base, nil
}

type service struct{}

func (service) Execute(_ []string, r <-chan svc.ChangeRequest, s chan<- svc.Status) (bool, uint32) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s <- svc.Status{State: svc.StartPending}
	done := make(chan error, 1)
	go func() {
		if err := recoverWindowsSplitDNS(); err != nil {
			done <- err
			return
		}
		done <- run(ctx)
	}()
	s <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case err := <-done:
			if err != nil {
				return true, 1
			}
			return false, 0
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				s <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				s <- svc.Status{State: svc.StopPending, WaitHint: 20000}
				cancel()
				if err := <-done; err != nil {
					return true, 1
				}
				return false, 0
			}
		}
	}
}
func platformMain() error { return svc.Run(serviceID, service{}) }
func listen(p pairing) (net.Listener, error) {
	if _, err := windows.StringToSid(p.SID); err != nil {
		return nil, errors.New("invalid paired user SID")
	}
	return winio.ListenPipe(`\\.\pipe\`+serviceID, &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;SY)(A;;GA;;;" + p.SID + ")", InputBufferSize: 65536, OutputBufferSize: 65536})
}
func peerAllowed(c net.Conn, p pairing) bool {
	pipe, ok := c.(interface{ Fd() uintptr })
	if !ok {
		return false
	}
	var pid uint32
	if windows.GetNamedPipeClientProcessId(windows.Handle(pipe.Fd()), &pid) != nil {
		return false
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(process)
	var token windows.Token
	if windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token) != nil {
		return false
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil || user.User.Sid.String() != p.SID {
		return false
	}
	buf := make([]uint16, 32768)
	size := uint32(len(buf))
	if windows.QueryFullProcessImageName(process, 0, &buf[0], &size) != nil {
		return false
	}
	return verifyCaller(windows.UTF16ToString(buf[:size]), p)
}
func containChild(cmd *exec.Cmd) (func(), error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err == nil {
		err = windows.AssignProcessToJobObject(job, process)
		windows.CloseHandle(process)
	}
	if err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	return func() { windows.CloseHandle(job) }, nil
}
func trustCertificate(cert *x509.Certificate, install bool, base string) error {
	name, _ := windows.UTF16PtrFromString("ROOT")
	store, err := windows.CertOpenStore(windows.CERT_STORE_PROV_SYSTEM_W, 0, 0, windows.CERT_SYSTEM_STORE_LOCAL_MACHINE|windows.CERT_STORE_OPEN_EXISTING_FLAG, uintptr(unsafe.Pointer(name)))
	if err != nil {
		return err
	}
	defer windows.CertCloseStore(store, 0)
	return updateCertificateStore(store, cert.Raw, install)
}
func updateCertificateStore(store windows.Handle, raw []byte, install bool) error {
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
