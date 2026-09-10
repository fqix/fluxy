package certs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"dev.fengqi.fluxy/helper/internal/platform"
)

func Trust(cert *x509.Certificate, install bool, base string) error {
	var directory, tool string
	var args []string
	if _, err := os.Stat("/usr/sbin/update-ca-certificates"); err == nil {
		directory = "/usr/local/share/ca-certificates"
		tool = "/usr/sbin/update-ca-certificates"
	} else if _, err := os.Stat("/usr/bin/update-ca-trust"); err == nil {
		directory = "/etc/pki/ca-trust/source/anchors"
		tool = "/usr/bin/update-ca-trust"
		args = []string{"extract"}
	} else {
		return errors.New("supported system CA store not found (install ca-certificates)")
	}
	sum := sha256.Sum256(cert.Raw)
	path := filepath.Join(directory, "fluxy-"+hex.EncodeToString(sum[:])+".crt")
	if install {
		if err := WritePublic(path, cert); err != nil {
			return err
		}
	} else {
		data, err := os.ReadFile(path)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if err == nil {
			block, _ := pem.Decode(data)
			if block == nil || !bytes.Equal(block.Bytes, cert.Raw) {
				return errors.New("installed certificate does not match")
			}
			if err = os.Remove(path); err != nil {
				return err
			}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, tool, args...)
	cmd.Env = platform.Env()
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("refresh system trust: %w", err)
	}
	return nil
}
