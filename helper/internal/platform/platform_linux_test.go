package platform

import (
	"net"
	"os"
	"path/filepath"
	"testing"

	"dev.fengqi.fluxy/helper/internal/protocol"
)

func TestUnixPeerCredentials(t *testing.T) {
	path := filepath.Join(t.TempDir(), "helper.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	peer, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	p := protocol.Pairing{UID: os.Getuid()}
	p.Caller.Path, _ = os.Executable()
	p.Caller.SHA256, _ = protocol.FileHash(p.Caller.Path)
	if !PeerAllowed(peer, p) {
		t.Fatal("valid peer rejected")
	}
	p.UID++
	if PeerAllowed(peer, p) {
		t.Fatal("different user accepted")
	}
}
