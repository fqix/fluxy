package main

import (
	"net"
	"os"
	"path/filepath"
	"testing"
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
	p := pairing{UID: os.Getuid()}
	p.Caller.Path, _ = os.Executable()
	p.Caller.Path, _ = filepath.EvalSymlinks(p.Caller.Path)
	p.Caller.SHA256, _ = fileHash(p.Caller.Path)
	if !peerAllowed(peer, p) {
		t.Fatal("valid peer rejected")
	}
	p.UID++
	if peerAllowed(peer, p) {
		t.Fatal("different user accepted")
	}
}
