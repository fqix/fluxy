//go:build !darwin

package main

import "errors"

func startSplitDNS(string, []string) (func() error, error) {
	return nil, errors.New("split DNS capture is only supported on macOS")
}
func waitSplitDNSReady([]string) error {
	return errors.New("split DNS capture is only supported on macOS")
}
func flushSplitDNSCache() {}
