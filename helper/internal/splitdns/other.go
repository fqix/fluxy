//go:build !darwin && !windows

package splitdns

import "errors"

func Start(string, []string) (func() error, error) {
	return nil, errors.New("split DNS capture is only supported on macOS")
}
func WaitReady([]string) error {
	return errors.New("split DNS capture is only supported on macOS")
}
func FlushCache() {}
