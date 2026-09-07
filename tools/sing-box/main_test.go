package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sagernet/sing-box/option"
)

func TestExecuteRejectsInvalidArguments(t *testing.T) {
	for _, args := range [][]string{{"run"}, {"check", "-c", "x", "extra"}, {"version", "extra"}, {"generate"}} {
		if err := execute(args, io.Discard, io.Discard); err == nil {
			t.Fatalf("accepted invalid arguments: %v", args)
		}
	}
}

func TestExecuteVersion(t *testing.T) {
	var stdout bytes.Buffer
	if err := execute([]string{"version"}, &stdout, io.Discard); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(stdout.Bytes(), []byte("Fluxy transport profile")) {
		t.Fatal("missing custom build identity")
	}
}

func TestExecuteCheck(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"log":{"disabled":true},"outbounds":[{"type":"direct","tag":"direct"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := execute([]string{"check", "-c", path}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
}

func TestServeStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(coreContext(context.Background()))
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- serve(ctx, option.Options{Log: &option.LogOptions{Disabled: true}}, false, io.Discard)
	}()
	cancel()
	select {
	case <-done:
		// Either startup notices cancellation or a started Box closes normally.
	case <-time.After(3 * time.Second):
		t.Fatal("core did not stop after cancellation")
	}
}
