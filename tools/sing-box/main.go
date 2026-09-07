// Fluxy transport core, built against the unmodified pinned sing-box submodule.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	box "github.com/sagernet/sing-box"
	C "github.com/sagernet/sing-box/constant"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing/common/json"
)

var revision = "development"

type usageError string

func (err usageError) Error() string { return string(err) }

func main() {
	if err := execute(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "fluxy-core:", err)
		var invalidUsage usageError
		if errors.As(err, &invalidUsage) {
			os.Exit(2)
		}
		os.Exit(1)
	}
}

func execute(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" {
		fmt.Fprintln(stdout, "Usage: fluxy-core version | check -c CONFIG | run -c CONFIG")
		return nil
	}
	command := args[0]
	if command == "version" && len(args) == 1 {
		// Keep the upstream version line for existing POC tooling.
		fmt.Fprintln(stdout, "sing-box version", C.Version)
		fmt.Fprintln(stdout, "Fluxy transport profile; revision", revision)
		return nil
	}
	if command != "check" && command != "run" {
		return usageError(fmt.Sprintf("unsupported command %q", command))
	}
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(stderr)
	var configPath string
	flags.StringVar(&configPath, "c", "", "configuration file")
	flags.StringVar(&configPath, "config", "", "configuration file")
	if err := flags.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return usageError(err.Error())
	}
	if configPath == "" || flags.NArg() != 0 {
		return usageError("exactly one configuration file is required: -c CONFIG")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if owner := os.Getenv("FLUXY_HELPER_PARENT"); command == "run" && owner != "" {
		pid, err := strconv.Atoi(owner)
		if err != nil || pid <= 1 || os.Getppid() != pid {
			return errors.New("helper parent is no longer alive")
		}
		// macOS reparents orphaned children. Cancel the same shutdown context even
		// when the helper receives SIGKILL and cannot terminate us itself.
		done := make(chan struct{})
		go func(ctx context.Context) {
			defer close(done)
			ticker := time.NewTicker(500 * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					if os.Getppid() != pid {
						stop()
						return
					}
				}
			}
		}(ctx)
		defer func() { stop(); <-done }()
	}
	// The privileged helper owns stdin. EOF also covers helper crashes on Windows,
	// where parent PID reparenting cannot be used as a liveness signal.
	if command == "run" && os.Getenv("FLUXY_HELPER_STDIN") == "1" {
		go func() { _, _ = io.Copy(io.Discard, os.Stdin); stop() }()
	}
	ctx = coreContext(ctx)
	options, err := readOptions(ctx, configPath)
	if err != nil {
		return err
	}
	return serve(ctx, options, command == "check", stderr)
}

func readOptions(ctx context.Context, path string) (option.Options, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return option.Options{}, fmt.Errorf("read configuration: %w", err)
	}
	options, err := json.UnmarshalExtendedContext[option.Options](ctx, data)
	if err != nil {
		return option.Options{}, fmt.Errorf("decode configuration: %w", err)
	}
	if options.Log == nil {
		options.Log = &option.LogOptions{}
	}
	options.Log.DisableColor = true
	return options, nil
}

func serve(ctx context.Context, options option.Options, checkOnly bool, stderr io.Writer) (err error) {
	// Bound shutdown even when a signal arrives during startup. The normal path
	// always closes the Box, allowing it to remove its own TUN interface/routes.
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-finished:
			return
		case <-ctx.Done():
		}
		timer := time.NewTimer(10 * time.Second)
		defer timer.Stop()
		select {
		case <-finished:
		case <-timer.C:
			fmt.Fprintln(stderr, "fluxy-core: graceful shutdown timed out")
			os.Exit(1)
		}
	}()
	instance, err := box.New(box.Options{Context: ctx, Options: options})
	if err != nil {
		return fmt.Errorf("create core: %w", err)
	}
	defer func() { err = errors.Join(err, instance.Close()) }()
	if checkOnly {
		return nil
	}
	if err := instance.Start(); err != nil {
		return fmt.Errorf("start core: %w", err)
	}
	<-ctx.Done()
	return nil
}
