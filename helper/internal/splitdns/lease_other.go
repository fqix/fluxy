//go:build !windows

package splitdns

import "errors"

// Lease is the elevated child that owns Windows NRPT rules for one session.
func Lease() error { return errors.New("native DNS lease requires Windows") }
