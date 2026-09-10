package platform

import (
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"unsafe"

	"dev.fengqi.fluxy/helper/internal/protocol"
	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func Env() []string {
	root, _ := windows.GetWindowsDirectory()
	return []string{"SystemRoot=" + root, "WINDIR=" + root, "PATH=" + filepath.Join(root, "System32"), "TEMP=" + os.TempDir()}
}
func SecureBase() (string, error) {
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

func Listen(p protocol.Pairing) (net.Listener, error) {
	if _, err := windows.StringToSid(p.SID); err != nil {
		return nil, errors.New("invalid paired user SID")
	}
	return winio.ListenPipe(`\\.\pipe\`+protocol.ServiceID, &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;SY)(A;;GA;;;" + p.SID + ")", InputBufferSize: 65536, OutputBufferSize: 65536})
}
func PeerAllowed(c net.Conn, p protocol.Pairing) bool {
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
	return protocol.VerifyCaller(windows.UTF16ToString(buf[:size]), p)
}
func ContainChild(cmd *exec.Cmd) (func(), error) {
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
