package tun

import (
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestInspectorControlAuthenticationAndEOF(t *testing.T) {
	input, send := io.Pipe()
	output, receive := io.Pipe()
	defer input.Close()
	defer receive.Close()
	token := strings.Repeat("a", 43)
	control, err := newInspectorControl(send, output, token)
	if err != nil {
		t.Fatal(err)
	}
	defer control.close()
	address := net.JoinHostPort("127.0.0.1", strconv.Itoa(control.port()))
	bad, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	bad.SetDeadline(time.Now().Add(time.Second))
	io.WriteString(bad, strings.Repeat("b", 43)+"\n")
	if _, err = bad.Read(make([]byte, 3)); err == nil {
		t.Fatal("unauthenticated control accepted")
	}
	bad.Close()
	peer, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	peer.SetDeadline(time.Now().Add(2 * time.Second))
	io.WriteString(peer, token+"\n")
	ack := make([]byte, 3)
	if _, err = io.ReadFull(peer, ack); err != nil || string(ack) != "OK\n" {
		t.Fatalf("handshake %q: %v", ack, err)
	}
	received := make(chan string, 1)
	go func() {
		bytes, err := io.ReadAll(input)
		if err != nil {
			received <- err.Error()
			return
		}
		received <- string(bytes)
	}()
	io.WriteString(peer, "framed desktop bytes\x00\n")
	forwarded := make(chan error, 1)
	go func() { _, err := io.WriteString(receive, "framed core bytes\x00\n"); forwarded <- err }()
	payload := make([]byte, len("framed core bytes\x00\n"))
	if _, err = io.ReadFull(peer, payload); err != nil || string(payload) != "framed core bytes\x00\n" {
		t.Fatalf("output %q: %v", payload, err)
	}
	if err = <-forwarded; err != nil {
		t.Fatal(err)
	}
	peer.Close()
	select {
	case data := <-received:
		if data != "framed desktop bytes\x00\n" {
			t.Fatalf("input %q", data)
		}
	case <-time.After(time.Second):
		t.Fatal("desktop EOF did not close core stdin")
	}
	select {
	case <-control.done:
	case <-time.After(time.Second):
		t.Fatal("relay goroutine leaked")
	}
}

func TestInspectorControlStopBeforeAuthentication(t *testing.T) {
	input, send := io.Pipe()
	defer input.Close()
	output, receive := io.Pipe()
	defer receive.Close()
	c, err := newInspectorControl(send, output, strings.Repeat("a", 43))
	if err != nil {
		t.Fatal(err)
	}
	c.close()
	select {
	case <-c.done:
	case <-time.After(time.Second):
		t.Fatal("accept did not stop")
	}
}
