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

func (s *Session) Running() bool {
	if s.child == nil {
		return false
	}
	select {
	case err := <-s.done:
		s.exitError = s.output.Failure("TUN core exited unexpectedly", err, s.password)
		s.child = nil
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
	child.Stdout, child.Stderr = output, output
	input, err := child.StdinPipe()
	if err != nil {
		return err
	}
	if err = child.Start(); err != nil {
		input.Close()
		return err
	}
	release, err := platform.ContainChild(child)
	if err != nil {
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
	go func() { done <- child.Wait() }()
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
	return nil
}
