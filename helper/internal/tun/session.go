package tun

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"dev.fengqi.fluxy/helper/internal/coreio"
	"dev.fengqi.fluxy/helper/internal/platform"
	"dev.fengqi.fluxy/helper/internal/protocol"
	"dev.fengqi.fluxy/helper/internal/splitdns"
)

// Session owns the single core process one connection may run.
type Session struct {
	control       *inspectorControl
	params        Params
	ready         bool
	base          string
	child         *exec.Cmd
	input         io.WriteCloser
	done          chan error
	release       func()
	interfaceName string
	dnsCleanup    func() error
	output        *coreio.Output
	password      string
	exitError     string
}

// NewSession prepares a session rooted in the administrator-owned directory.
func NewSession(base string) *Session { return &Session{base: base} }

// Error reports why the core exited, if it did.
func (s *Session) Error() string { return s.exitError }
func (s *Session) ControlPort() int {
	if s.control != nil {
		return s.control.port()
	}
	return 0
}

func (s *Session) Running() bool {
	if s.child == nil {
		return false
	}
	select {
	case err := <-s.done:
		s.exitError = s.output.Failure("TUN core exited unexpectedly", err, s.password)
		s.child = nil
		if s.control != nil {
			s.control.close()
		}
		s.input.Close()
		s.release()
		if s.dnsCleanup != nil {
			if err := s.dnsCleanup(); err != nil {
				s.exitError += "; " + err.Error()
			} else {
				s.dnsCleanup = nil
			}
			splitdns.FlushCache()
		}
		return false
	default:
		return true
	}
}
func (s *Session) Stop() error {
	if s.control != nil {
		s.control.close()
		<-s.control.done
		s.control = nil
	}
	s.ready = false
	if s.dnsCleanup != nil {
		if err := s.dnsCleanup(); err != nil {
			return err
		}
		s.dnsCleanup = nil
		splitdns.FlushCache()
	}
	if s.Running() {
		s.input.Close() // core observes EOF and removes its routes before exiting
		select {
		case <-s.done:
		case <-time.After(12 * time.Second):
			_ = s.child.Process.Kill()
			<-s.done
		}
		s.release()
		s.child = nil
	}
	_ = os.Remove(filepath.Join(s.base, "json"))
	// Windows retains Wintun adapters briefly. Do not report a successful stop early.
	if s.interfaceName != "" {
		until := time.Now().Add(3 * time.Second)
		for {
			if _, err := net.InterfaceByName(s.interfaceName); err != nil {
				s.interfaceName = ""
				break
			}
			if time.Now().After(until) {
				return errors.New("TUN interface has not disappeared")
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	return nil
}
func (s *Session) Start(raw json.RawMessage) error {
	var p Params
	if err := protocol.Decode(raw, &p); err != nil {
		return err
	}
	if err := p.Validate(); err != nil {
		return err
	}
	if err := s.Stop(); err != nil {
		return err
	}
	s.exitError = ""
	if _, err := net.InterfaceByName(p.InterfaceName); err == nil {
		return errors.New("TUN interface already exists")
	}
	data, err := json.Marshal(Config(p))
	if err != nil {
		return err
	}
	path := filepath.Join(s.base, "json")
	if err = os.WriteFile(path, data, 0600); err != nil {
		return err
	}
	core := filepath.Join(s.base, "sing-box"+ExeSuffix())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	check := exec.CommandContext(ctx, core, "check", "-c", path)
	check.Env = platform.Env()
	checkOutput := &coreio.Output{}
	check.Stdout, check.Stderr = checkOutput, checkOutput
	if err = check.Run(); err != nil {
		return errors.New(checkOutput.Failure("core configuration check failed", err, p.Password))
	}
	child := exec.Command(core, "run", "-c", path)
	child.Env = append(platform.Env(), "FLUXY_HELPER_STDIN=1")
	output := &coreio.Output{}
	child.Stderr = output
	if p.Inspector == nil {
		child.Stdout = output
	}
	input, err := child.StdinPipe()
	if err != nil {
		return err
	}
	if p.Inspector != nil {
		stdout, pipeErr := child.StdoutPipe()
		if pipeErr != nil {
			input.Close()
			return pipeErr
		}
		s.control, err = newInspectorControl(input, stdout, p.Password)
		if err != nil {
			input.Close()
			stdout.Close()
			return err
		}
	}
	if err = child.Start(); err != nil {
		if s.control != nil {
			s.control.close()
			<-s.control.done
			s.control = nil
		}

		input.Close()
		return err
	}
	release, err := platform.ContainChild(child)
	if err != nil {
		if s.control != nil {
			s.control.close()
			<-s.control.done
			s.control = nil
		}
		input.Close()
		_ = child.Process.Kill()
		_ = child.Wait()
		return err
	}
	s.child = child
	s.input = input
	s.release = release
	done := make(chan error, 1)
	s.done = done
	s.output = output
	s.password = p.Password
	s.interfaceName = p.InterfaceName
	s.params = p
	go func() { done <- child.Wait() }()
	if p.Inspector != nil {
		return nil
	} // Desktop must send the inspector start frame first.
	return s.Ready()
}

// Ready finishes network setup after the desktop initializes the inspector.
func (s *Session) Ready() error {
	if !s.Running() {
		return errors.New("TUN core is not running: " + s.exitError)
	}
	if s.ready {
		return nil
	}
	p := s.params
	var err error
	if p.Inspector != nil {
		deadline := time.Now().Add(10 * time.Second)
		for {
			if !s.Running() {
				return errors.New(s.exitError)
			}
			if s.output.Contains("sing-box started (") {
				break
			}
			if time.Now().After(deadline) {
				return errors.New("TUN inbounds did not become ready")
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	if p.SplitDNS != nil && !protocol.Testing {
		if err = splitdns.WaitReady(p.SplitDNS.Domains); err == nil {
			s.dnsCleanup, err = splitdns.Start(p.InterfaceName, p.SplitDNS.Domains)
		}
		if err != nil {
			if !s.Running() && s.exitError != "" {
				err = errors.Join(err, errors.New(s.exitError))
			}
			stopErr := s.Stop()
			return errors.Join(err, stopErr)
		}
		splitdns.FlushCache()
	}
	s.ready = true
	return nil
}
