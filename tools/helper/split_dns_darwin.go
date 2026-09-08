package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os/exec"
	"strings"
	"sync"
	"time"
)

func splitDNSScript(name string, domains []string) string {
	matches := strings.Join(domains, " ")
	if len(domains) == 0 {
		matches = `""`
	}
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

func waitSplitDNSReady(domains []string) error {
	deadline := time.Now().Add(8 * time.Second)
	// Query a matched domain so readiness never depends on an external DNS answer.
	name := "fluxy.invalid"
	if len(domains) > 0 {
		name = domains[0]
	}
	query := []byte{0x46, 0x58, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0}
	for _, label := range strings.Split(name, ".") {
		query = append(query, byte(len(label)))
		query = append(query, label...)
	}
	query = append(query, 0, 0, 1, 0, 1)
	for time.Now().Before(deadline) {
		connection, err := net.DialTimeout("udp", splitDNSAddress+":53", 300*time.Millisecond)
		if err == nil {
			_ = connection.SetDeadline(time.Now().Add(300 * time.Millisecond))
			_, err = connection.Write(query)
			reply := make([]byte, 512)
			if err == nil {
				var count int
				count, err = connection.Read(reply)
				if err == nil && count >= 12 && reply[0] == 0x46 && reply[1] == 0x58 &&
					reply[2]&0x80 != 0 && reply[3]&15 == 0 && (reply[6] != 0 || reply[7] != 0) {
					connection.Close()
					return nil
				}
			}
			connection.Close()
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("Fluxy Fake IP DNS did not become ready at %s", splitDNSAddress)
}

func flushSplitDNSCache() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "/usr/bin/dscacheutil", "-flushcache")
	command.Env = cleanEnv()
	_ = command.Run()
}
