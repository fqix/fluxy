// Package protocol holds the primitives every helper component shares: the
// service identity, the build mode, strict JSON decoding and TUN naming rules.
package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"runtime"
)

// ServiceID names the launchd job, the systemd unit and the Windows service.
const ServiceID = "dev.fengqi.fluxy.electron.helper"

// Decode rejects unknown fields and trailing JSON so no request smuggles extra
// data past a validated structure.
func Decode(data []byte, target any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}

// ValidInterfaceName accepts only names the helper itself creates.
func ValidInterfaceName(name string) bool {
	prefix := "fluxy"
	if runtime.GOOS == "darwin" {
		prefix = "utun"
	}
	return regexp.MustCompile("^" + prefix + `[0-9]{4,5}$`).MatchString(name)
}
