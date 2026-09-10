package setup

import (
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"dev.fengqi.fluxy/helper/internal/certs"
	"dev.fengqi.fluxy/helper/internal/protocol"
)

func TestNativeInstallerResult(t *testing.T) {
	for _, test := range []struct {
		name, output string
		ok           bool
	}{
		{"success", "marker:0\n", true},
		{"output", "installer output\nmarker:0\n", true},
		{"failure", "permission denied\nmarker:1\n", false},
		{"missing result", "installer died", false},
		{"incomplete", "marker:", false},
		{"not a result line", "error marker:0\n", false},
		{"trailing failure", "marker:0\nmarker:1\n", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := nativeInstallerResult([]byte(test.output), "marker:")
			if (err == nil) != test.ok {
				t.Fatalf("result error = %v, success want %v", err, test.ok)
			}
		})
	}
}

func TestNativeSetupRunsTrustOnlyAfterSuccessfulInstallation(t *testing.T) {
	for _, installOK := range []bool{true, false} {
		t.Run(fmt.Sprint(installOK), func(t *testing.T) {
			directory := t.TempDir()
			received := filepath.Join(directory, "certificate.json")
			fake := filepath.Join(directory, "helper")
			script := "#!/bin/sh\n[ \"$1\" = trust-ca-privileged ] || exit 19\ncat > '" + received + "'\n"
			if err := os.WriteFile(fake, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			cert := &x509.Certificate{Raw: []byte("public certificate bytes")}
			install := "(exit 0)"
			if !installOK {
				install = "(exit 7)"
			}
			command := nativeSetupCommand(install, cert)
			command = strings.ReplaceAll(command, "/Library/PrivilegedHelperTools/"+protocol.ServiceID+"/fluxy-helper", fake)
			err := exec.Command("/bin/sh", "-c", command).Run()
			if !installOK {
				if err == nil {
					t.Fatal("failed installation reported success")
				}
				if _, err := os.Stat(received); !os.IsNotExist(err) {
					t.Fatal("trust ran after failed install")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(received)
			if err != nil {
				t.Fatal(err)
			}
			var encoded string
			if err := json.Unmarshal(data, &encoded); err != nil {
				t.Fatal(err)
			}
			public, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil || string(public) != string(cert.Raw) {
				t.Fatal("public certificate changed in transit")
			}
		})
	}
}

func TestNativeSetupPreservesHelperOnlyOperation(t *testing.T) {
	if got := nativeSetupCommand("(exit 0)", nil); got != "(exit 0)" {
		t.Fatalf("unexpected certificate step: %s", got)
	}
}

func TestPrivilegedTrustRejectsDesktopCaller(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("requires unprivileged desktop user")
	}
	if err := certs.TrustPrivileged(&x509.Certificate{}); err == nil {
		t.Fatal("unprivileged certificate mutation accepted")
	}
}

func TestNativeSetupPropagatesTrustFailure(t *testing.T) {
	fake := filepath.Join(t.TempDir(), "helper")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\ncat >/dev/null\necho 'trust denied' >&2\nexit 23\n"), 0700); err != nil {
		t.Fatal(err)
	}
	command := nativeSetupCommand("(exit 0)", &x509.Certificate{Raw: []byte("public")})
	command = strings.ReplaceAll(command, "/Library/PrivilegedHelperTools/"+protocol.ServiceID+"/fluxy-helper", fake)
	output, err := exec.Command("/bin/sh", "-c", command).CombinedOutput()
	var failure *exec.ExitError
	if !errors.As(err, &failure) || failure.ExitCode() != 23 || !strings.Contains(string(output), "trust denied") {
		t.Fatalf("trust failure lost: output=%q error=%v", output, err)
	}
}

func TestNativeInstallerFailureHidesResultMarker(t *testing.T) {
	marker := "FLUXY_AUTH_RESULT_secret:"
	err := nativeInstallerResult([]byte("Helper service did not unload\n"+marker+"1\n"), marker)
	if err == nil || !strings.Contains(err.Error(), "Helper service did not unload") || strings.Contains(err.Error(), marker) {
		t.Fatalf("unexpected diagnostic: %v", err)
	}
	err = nativeInstallerResult([]byte(marker+"23\n"), marker)
	if err == nil || !strings.Contains(err.Error(), "exit status 23") || strings.Contains(err.Error(), marker) {
		t.Fatalf("unexpected exit diagnostic: %v", err)
	}
	if err := nativeInstallerResult([]byte(marker+"0\nlate failure"), marker); err == nil {
		t.Fatal("trailing failure ignored")
	}
}
