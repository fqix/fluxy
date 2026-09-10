//go:build !windows

package setup

import "errors"

func WindowsCommand() error { return errors.New("native setup requires Windows") }
