//go:build !windows

package winnet

import "errors"

func Command(string, []byte) (any, error) {
	return nil, errors.New("native network query requires Windows")
}
