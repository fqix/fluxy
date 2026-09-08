package main

import (
	"errors"
	"strings"
	"sync"
	"testing"
)

func TestCoreOutput(t *testing.T) {
	output := &coreOutput{}
	password := strings.Repeat("s", 43)
	_, _ = output.Write([]byte(strings.Repeat("x", coreOutputLimit*2)))
	_, _ = output.Write([]byte("\nfatal: address already in use " + password))
	message := output.failure("TUN core exited unexpectedly", errors.New("exit status 1"), password)
	if len(output.tail) > coreOutputLimit || !strings.Contains(message, "exit status 1") || !strings.Contains(message, "fatal: address already in use [redacted]") || strings.Contains(message, password) {
		t.Fatalf("incorrect bounded diagnostics: length %d", len(message))
	}
}

func TestCoreOutputConcurrent(t *testing.T) {
	output := &coreOutput{}
	var writers sync.WaitGroup
	for range 2 {
		writers.Go(func() {
			for range 100 {
				_, _ = output.Write([]byte(strings.Repeat("log", 100)))
				_ = output.failure("core exited", nil, "")
			}
		})
	}
	writers.Wait()
	if !strings.HasPrefix(output.failure("core exited", nil, ""), "core exited: exit status 0\n") {
		t.Fatal("missing clean but unexpected exit status")
	}
}
