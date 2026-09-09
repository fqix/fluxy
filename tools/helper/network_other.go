//go:build !windows

package main

import "errors"

func platformDNSLease() error { return errors.New("native DNS lease requires Windows") }
func platformNetworkCommand(string, []byte) (any, error) {
	return nil, errors.New("native network query requires Windows")
}
