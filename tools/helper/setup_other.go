//go:build !windows

package main

import "errors"

func nativeSetupCommand() error { return errors.New("native setup requires Windows") }
