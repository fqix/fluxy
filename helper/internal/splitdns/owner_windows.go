package splitdns

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"dev.fengqi.fluxy/helper/internal/coreio"
	"dev.fengqi.fluxy/helper/internal/platform"
	"dev.fengqi.fluxy/helper/internal/protocol"
)

type dnsLeaseRequest struct {
	InterfaceName string `json:"interfaceName"`
	DNS           Params `json:"dns"`
}

func Start(name string, domains []string) (func() error, error) {
	if !protocol.ValidInterfaceName(name) {
		return nil, errors.New("invalid split DNS interface")
	}
	if err := validateDomains(domains); err != nil {
		return nil, err
	}
	if err := Recover(); err != nil {
		return nil, err
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	command := exec.Command(executable, "dns-lease")
	command.Env = platform.Env()
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	payload, _ := json.Marshal(dnsLeaseRequest{InterfaceName: name, DNS: Params{Domains: domains}})
	return startWindowsDNSOwner(command, payload, func() error { return systemNRPT().remove(protocol.ServiceID + "." + name) })
}

// Only the protected, elevated helper can enter the mutating lease command.
func Lease() error {
	if _, err := platform.SecureBase(); err != nil {
		return err
	}
	reader := bufio.NewReaderSize(os.Stdin, 65536)
	line, err := reader.ReadSlice('\n')
	if err != nil {
		return err
	}
	var request dnsLeaseRequest
	if err := protocol.Decode(line, &request); err != nil {
		return err
	}
	if !protocol.ValidInterfaceName(request.InterfaceName) {
		return errors.New("invalid split DNS interface")
	}
	return runNativeDNSLease(reader, os.Stdout, systemNRPT(), request)
}

func runNativeDNSLease(input io.Reader, output io.Writer, store nrptStore, request dnsLeaseRequest) (result error) {
	cleanup, err := store.install(request.InterfaceName, request.DNS.Domains)
	if cleanup != nil {
		defer func() {
			if err := cleanup(); err != nil {
				result = errors.Join(result, err)
			} else {
				fmt.Fprintln(output, "FLUXY_DNS_CLEAN")
			}
		}()
	}
	if err != nil {
		return err
	}
	if store.verify != nil {
		if err := store.verify(request.DNS.Domains); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintln(output, "FLUXY_DNS_READY"); err != nil {
		return err
	}
	// No arbitrary commands: the only remaining input is a lease termination.
	var end [1]byte
	_, err = input.Read(end[:])
	if err != nil && err != io.EOF {
		return err
	}
	return nil
}

func startWindowsDNSOwner(command *exec.Cmd, payload []byte, restore func() error) (func() error, error) {
	input, err := command.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := command.StdoutPipe()
	if err != nil {
		input.Close()
		return nil, err
	}
	diagnostics := &coreio.Output{}
	command.Stderr = diagnostics
	if err = command.Start(); err != nil {
		input.Close()
		return nil, err
	}
	if _, err := input.Write(append(payload, '\n')); err != nil {
		input.Close()
		_ = command.Wait()
		return nil, err
	}
	ready := make(chan bool, 1)
	done := make(chan struct{})
	var result error
	cleaned := false
	go func() {
		scanner := bufio.NewScanner(output)
		confirmed := false
		for scanner.Scan() {
			if scanner.Text() == "FLUXY_DNS_CLEAN" {
				cleaned = true
			}
			if !confirmed && scanner.Text() == "FLUXY_DNS_READY" {
				confirmed = true
				ready <- true
			}
		}
		if !confirmed {
			ready <- false
		}
		result = command.Wait()
		close(done)
	}()
	var once sync.Once
	cleanup := func() error {
		once.Do(func() { input.Close() })
		select {
		case <-done:
			if !cleaned {
				if restore != nil {
					return restore()
				}
				return errors.New(diagnostics.Failure("Windows split DNS cleanup failed", result, ""))
			}
			return nil
		case <-time.After(15 * time.Second):
			// Do not kill the owner in the middle of restoring DNS. Stop can retry.
			return errors.New("Windows split DNS cleanup is still pending; retry Stop")
		}
	}
	select {
	case ok := <-ready:
		if ok {
			return cleanup, nil
		}
		err = errors.New(diagnostics.Failure("Windows split DNS registration failed", nil, ""))
	case <-time.After(30 * time.Second):
		err = errors.New("Windows split DNS registration timed out")
	}
	return cleanup, errors.Join(err, cleanup())
}
