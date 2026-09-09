//go:build !windows

package main

import "errors"

func windowsSetupCommand() error { return errors.New("native setup requires Windows") }
