package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
	"unsafe"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

type setupRequest struct {
	Action        string `json:"action"`
	Stage         string `json:"stage,omitempty"`
	HelperSHA256  string `json:"helperSHA256,omitempty"`
	CoreSHA256    string `json:"coreSHA256,omitempty"`
	PairingSHA256 string `json:"pairingSHA256,omitempty"`
}

func (r setupRequest) validate() error {
	if r.Action == "uninstall" && r.Stage == "" && r.HelperSHA256 == "" && r.CoreSHA256 == "" && r.PairingSHA256 == "" {
		return nil
	}
	if r.Action != "install" || !filepath.IsAbs(r.Stage) || strings.ContainsRune(r.Stage, 0) {
		return errors.New("invalid native setup request")
	}
	for _, hash := range []string{r.HelperSHA256, r.CoreSHA256, r.PairingSHA256} {
		if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(hash) {
			return errors.New("invalid setup checksum")
		}
	}
	return nil
}
func nativeSID() (string, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String(), nil
}

// ShellExecuteEx invokes the UAC broker directly; no command interpreter is involved.
type shellExecuteInfo struct {
	Size       uint32
	Mask       uint32
	Window     windows.Handle
	Verb       *uint16
	File       *uint16
	Parameters *uint16
	Directory  *uint16
	Show       int32
	Instance   windows.Handle
	IDList     uintptr
	Class      *uint16
	ClassKey   windows.Handle
	HotKey     uint32
	Icon       windows.Handle
	Process    windows.Handle
}

func elevateSetup(r setupRequest) error {
	if err := r.validate(); err != nil {
		return err
	}
	sid, err := nativeSID()
	if err != nil {
		return err
	}
	nonce := make([]byte, 24)
	if _, err = rand.Read(nonce); err != nil {
		return err
	}
	pipe := `\\.\pipe\` + serviceID + ".setup." + hex.EncodeToString(nonce)
	listener, err := winio.ListenPipe(pipe, &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;" + sid + ")"})
	if err != nil {
		return err
	}
	defer listener.Close()
	result := make(chan error, 1)
	go func() {
		c, e := listener.Accept()
		if e != nil {
			result <- e
			return
		}
		defer c.Close()
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Minute))
		var reply struct {
			Error string `json:"error"`
		}
		e = json.NewDecoder(io.LimitReader(c, 16384)).Decode(&reply)
		if e == nil && reply.Error != "" {
			e = errors.New(reply.Error)
		}
		result <- e
	}()
	payload, _ := json.Marshal(r)
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString(exe)
	parameters, _ := windows.UTF16PtrFromString("setup-elevated " + base64.RawURLEncoding.EncodeToString(payload) + " " + pipe)
	info := shellExecuteInfo{Mask: 0x40 | 0x100 | 0x400, Verb: verb, File: file, Parameters: parameters, Show: windows.SW_HIDE}
	info.Size = uint32(unsafe.Sizeof(info))
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err = windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED); err != nil {
		return err
	}
	defer windows.CoUninitialize()
	ok, _, callErr := windows.NewLazySystemDLL("shell32.dll").NewProc("ShellExecuteExW").Call(uintptr(unsafe.Pointer(&info)))
	if ok == 0 {
		return fmt.Errorf("Windows authorization: %w", callErr)
	}
	defer windows.CloseHandle(info.Process)
	done := make(chan error, 1)
	go func() { _, e := windows.WaitForSingleObject(info.Process, windows.INFINITE); done <- e }()
	select {
	case err = <-result:
		<-done
		return err
	case err = <-done:
		if err != nil {
			return err
		}
		select {
		case err = <-result:
			return err
		case <-time.After(time.Second):
			var code uint32
			_ = windows.GetExitCodeProcess(info.Process, &code)
			return fmt.Errorf("native setup exited without a result (code %d)", code)
		}
	}
}
func windowsSetupCommand() error {
	if len(os.Args) == 2 && os.Args[1] == "setup-native" {
		data, err := io.ReadAll(io.LimitReader(os.Stdin, 65537))
		if err != nil {
			return err
		}
		if len(data) > 65536 {
			return errors.New("oversized setup input")
		}
		var r setupRequest
		if err = decode(data, &r); err != nil {
			return err
		}
		return elevateSetup(r)
	}
	if len(os.Args) != 4 || os.Args[1] != "setup-elevated" {
		return errors.New("invalid native setup command")
	}
	if !windows.GetCurrentProcessToken().IsElevated() {
		return errors.New("setup requires Windows administrator approval")
	}
	if !regexp.MustCompile(`^\\\\\.\\pipe\\dev\.fengqi\.fluxy\.electron\.helper\.setup\.[a-f0-9]{48}$`).MatchString(os.Args[3]) {
		return errors.New("invalid setup reply pipe")
	}
	timeout := 10 * time.Second
	c, err := winio.DialPipe(os.Args[3], &timeout)
	if err != nil {
		return err
	}
	defer c.Close()
	data, err := base64.RawURLEncoding.DecodeString(os.Args[2])
	var r setupRequest
	if err == nil {
		err = decode(data, &r)
	}
	if err == nil {
		err = r.validate()
	}
	if err == nil {
		err = performNativeSetup(r)
	}
	reply := struct {
		Error string `json:"error"`
	}{}
	if err != nil {
		reply.Error = err.Error()
	}
	_ = json.NewEncoder(c).Encode(reply)
	return err
}
func protectedDirectory(path string) error {
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if err != nil {
		return err
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	attributes := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: descriptor}
	return windows.CreateDirectory(name, &attributes)
}
func checkSetupPath(root, path string) error {
	if filepath.Dir(filepath.Clean(path)) != filepath.Clean(root) {
		return errors.New("setup path escapes Program Files")
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	name, _ := windows.UTF16PtrFromString(path)
	attrs, err := windows.GetFileAttributes(name)
	if err != nil {
		return err
	}
	if !info.IsDir() || attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("unsafe helper installation directory")
	}
	return nil
}
func copyPinned(source, dest, hash string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	digest := sha256.New()
	_, err = io.Copy(io.MultiWriter(out, digest), in)
	closeErr := out.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if hex.EncodeToString(digest.Sum(nil)) != hash {
		return errors.New("Helper integrity check failed: " + filepath.Base(source))
	}
	return nil
}
func stopSetupService(s *mgr.Service) error {
	state, err := s.Query()
	if err != nil {
		return err
	}
	var process windows.Handle
	if state.ProcessId != 0 {
		process, err = windows.OpenProcess(windows.SYNCHRONIZE, false, state.ProcessId)
		if err != nil && !errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return err
		}
		if process != 0 {
			defer windows.CloseHandle(process)
		}
	}
	if state.State != svc.Stopped && state.State != svc.StopPending {
		if _, err = s.Control(svc.Stop); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
			return err
		}
	}
	deadline := time.Now().Add(30 * time.Second)
	for state.State != svc.Stopped {
		if time.Now().After(deadline) {
			return errors.New("Helper service stop timed out")
		}
		time.Sleep(100 * time.Millisecond)
		state, err = s.Query()
		if err != nil {
			return err
		}
	}
	if process != 0 {
		status, err := windows.WaitForSingleObject(process, 30000)
		if err != nil {
			return err
		}
		if status != windows.WAIT_OBJECT_0 {
			return errors.New("Helper process is still stopping")
		}
	}
	return nil
}
func performNativeSetup(r setupRequest) (resultErr error) {
	step := "locate Program Files"
	defer func() {
		if resultErr != nil {
			resultErr = fmt.Errorf("native setup (%s): %w", step, resultErr)
		}
	}()
	root, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	if err != nil {
		return err
	}
	base := filepath.Join(root, "FluxyHelper")
	if err = checkSetupPath(root, base); err != nil {
		return err
	}
	step = "connect Service Control Manager"
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	step = "open Helper service"
	s, err := manager.OpenService(serviceID)
	if err != nil && !errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return err
	}
	defer func() {
		if s != nil {
			s.Close()
		}
	}()
	if r.Action == "uninstall" {
		if s != nil {
			if err = stopSetupService(s); err != nil {
				return err
			}
			if err = s.Delete(); err != nil {
				return err
			}
		}
		return os.RemoveAll(base)
	}
	nonce := make([]byte, 16)
	if _, err = rand.Read(nonce); err != nil {
		return err
	}
	stage := filepath.Join(root, "FluxyInstall-"+hex.EncodeToString(nonce))
	backup := stage + "-previous"
	step = "create protected staging directory"
	if err = protectedDirectory(stage); err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	step = "copy and verify installation files"
	for _, entry := range [][3]string{{"fluxy-helper", "fluxy-helper.exe", r.HelperSHA256}, {"fluxy-core", "fluxy-core.exe", r.CoreSHA256}, {"pairing.json", "pairing.json", r.PairingSHA256}} {
		if err = copyPinned(filepath.Join(r.Stage, entry[0]), filepath.Join(stage, entry[1]), entry[2]); err != nil {
			return err
		}
	}
	data, err := os.ReadFile(filepath.Join(stage, "pairing.json"))
	if err != nil {
		return err
	}
	var p pairing
	if err = decode(data, &p); err != nil {
		return err
	}
	hex64 := regexp.MustCompile(`^[a-f0-9]{64}$`)
	if !hex64.MatchString(p.Token) || !hex64.MatchString(p.BuildID) || !hex64.MatchString(p.Caller.SHA256) || !filepath.IsAbs(p.Caller.Path) {
		return errors.New("invalid pairing")
	}
	if _, err = windows.StringToSid(p.SID); err != nil {
		return err
	}
	step = "read existing service configuration"
	var previous mgr.Config
	if s != nil {
		previous, err = s.Config()
		// A partially removed service can remain in SCM while its registry
		// configuration is gone. Remove that stopped record before recreation.
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			step = "repair incomplete service registration"
			if err = stopSetupService(s); err != nil {
				return err
			}
			if err = s.Delete(); err != nil {
				return err
			}
			s.Close()
			s = nil
			deadline := time.Now().Add(10 * time.Second)
			for {
				probe, probeErr := manager.OpenService(serviceID)
				if errors.Is(probeErr, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
					break
				}
				if probe != nil {
					probe.Close()
				}
				if probeErr != nil && !errors.Is(probeErr, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
					return probeErr
				}
				if time.Now().After(deadline) {
					return errors.New("incomplete Helper service is pending deletion; restart Windows before retrying")
				}
				time.Sleep(100 * time.Millisecond)
			}
		}
		if err != nil {
			return err
		}
		step = "stop existing service"
		if s != nil {
			if err = stopSetupService(s); err != nil {
				return err
			}
		}
	}
	step = "activate installation directory"
	hadPrevious := false
	if _, err = os.Stat(base); err == nil {
		if err = os.Rename(base, backup); err != nil {
			return err
		}
		hadPrevious = true
	} else if !os.IsNotExist(err) {
		return err
	}
	if err = os.Rename(stage, base); err != nil {
		if hadPrevious {
			_ = os.Rename(backup, base)
		}
		return err
	}
	committed := false
	created := false
	defer func() {
		if committed {
			if hadPrevious {
				_ = os.RemoveAll(backup)
			}
			return
		}
		if s != nil {
			if cleanupErr := stopSetupService(s); cleanupErr != nil {
				resultErr = errors.Join(resultErr, fmt.Errorf("rollback could not stop Helper: %w", cleanupErr))
				return
			}
			if created {
				resultErr = errors.Join(resultErr, s.Delete())
			} else {
				resultErr = errors.Join(resultErr, s.UpdateConfig(previous))
			}
		}
		if cleanupErr := os.RemoveAll(base); cleanupErr != nil {
			resultErr = errors.Join(resultErr, cleanupErr)
			return
		}
		if hadPrevious {
			if cleanupErr := os.Rename(backup, base); cleanupErr != nil {
				resultErr = errors.Join(resultErr, cleanupErr)
				return
			}
			if s != nil && !created {
				resultErr = errors.Join(resultErr, s.Start())
			}
		}
	}()
	step = "register native service"
	binary := filepath.Join(base, "fluxy-helper.exe")
	if s == nil {
		s, err = manager.CreateService(serviceID, binary, mgr.Config{DisplayName: "Fluxy Helper", StartType: mgr.StartAutomatic, ServiceStartName: "LocalSystem"})
		if err != nil {
			return err
		}
		created = true
	} else {
		updated := previous
		updated.BinaryPathName = windows.EscapeArg(binary)
		updated.StartType = mgr.StartAutomatic
		updated.ServiceStartName = "LocalSystem"
		if err = s.UpdateConfig(updated); err != nil {
			return err
		}
	}
	step = "start native service"
	if err = s.Start(); err != nil {
		return err
	}
	deadline := time.Now().Add(20 * time.Second)
	for {
		state, e := s.Query()
		if e != nil {
			return e
		}
		if state.State == svc.Running {
			break
		}
		if state.State == svc.Stopped {
			return fmt.Errorf("Helper exited during startup (code %d)", state.Win32ExitCode)
		}
		if time.Now().After(deadline) {
			return errors.New("Helper service start timed out")
		}
		time.Sleep(100 * time.Millisecond)
	}
	committed = true
	return nil
}
