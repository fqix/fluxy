package protocol

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"runtime"
	"strings"
)

// Pairing is the administrator-owned record that binds the helper to one
// desktop executable, one local user and one build.
type Pairing struct {
	UID     int    `json:"uid"`
	SID     string `json:"sid"`
	Token   string `json:"token"`
	BuildID string `json:"buildID"`
	Caller  struct {
		Path     string  `json:"path"`
		SHA256   string  `json:"sha256"`
		TeamID   *string `json:"teamID"`
		Portable bool    `json:"portable,omitempty"`
	} `json:"caller"`
}

func FileHash(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// VerifyCaller pins the connected executable to the paired path and hash.
func VerifyCaller(path string, p Pairing) bool {
	same := path == p.Caller.Path || (runtime.GOOS == "linux" && p.Caller.Portable)
	if runtime.GOOS == "windows" {
		same = strings.EqualFold(path, p.Caller.Path)
	}
	hash, err := FileHash(path)
	return same && err == nil && hash == p.Caller.SHA256
}
