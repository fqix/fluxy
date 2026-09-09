package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

func splitDNSScript(name string, domains []string) string {
	matches := strings.Join(domains, " ")
	key := "State:/Network/Service/" + serviceID + "." + name + "/DNS"
	return "d.init\n" +
		"d.add ServerAddresses * " + splitDNSAddress + "\n" +
		"d.add SupplementalMatchDomains * " + matches + "\n" +
		"d.add SupplementalMatchDomainsNoSearch # 1\n" +
		"d.add SearchOrder # 1\n" +
		"add " + key + " temporary\nshow " + key + "\n"
}

func startSplitDNS(name string, domains []string) (func() error, error) {
	return startSplitDNSProcess(name, domains, exec.Command("/usr/sbin/scutil"))
}

func startSplitDNSProcess(name string, domains []string, command *exec.Cmd) (func() error, error) {
	if err := validateCaptureDomains(domains); err != nil {
		return nil, err
	}
	if !validInterfaceName(name) {
		return nil, errors.New("invalid split DNS interface")
	}
	// scutil owns a temporary Dynamic Store key. EOF, helper crash, or normal Stop
	// closes its session and removes ONLY Fluxy's resolver, never another VPN's DNS.
	command.Env = cleanEnv()
	input, err := command.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := command.StdoutPipe()
	if err != nil {
		input.Close()
		return nil, err
	}
	if err = command.Start(); err != nil {
		input.Close()
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	var closeOnce sync.Once
	var closeErr error
	cleanup := func() error {
		closeOnce.Do(func() {
			input.Close()
			select {
			case closeErr = <-done:
			case <-time.After(3 * time.Second):
				_ = command.Process.Kill()
				closeErr = <-done
			}
		})
		return closeErr
	}
	ready := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(output)
		confirmed := false
		for scanner.Scan() {
			line := scanner.Text()
			if !confirmed && strings.Contains(line, "0 : "+splitDNSAddress) {
				confirmed = true
				ready <- nil
			}
		}
		if !confirmed {
			ready <- errors.New("could not register the split DNS resolver")
		}
	}()
	if _, err = io.WriteString(input, splitDNSScript(name, domains)); err != nil {
		_ = cleanup()
		return nil, err
	}
	select {
	case err = <-ready:
	case <-time.After(3 * time.Second):
		err = errors.New("split DNS registration timed out")
	}
	if err != nil {
		_ = cleanup()
		return nil, err
	}
	return cleanup, nil
}

func flushSplitDNSCache() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "/usr/bin/dscacheutil", "-flushcache")
	command.Env = cleanEnv()
	_ = command.Run()
}
