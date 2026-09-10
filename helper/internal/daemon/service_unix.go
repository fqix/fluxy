//go:build darwin || linux

package daemon

import (
	"context"
	"os"
	"os/signal"
	"syscall"
)

// Main runs the helper under launchd or systemd, which stop it with SIGTERM.
func Main() error {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer cancel()
	return run(ctx)
}
