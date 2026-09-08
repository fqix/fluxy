package main

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

func TestTrackedConnReadDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		client, server := net.Pipe()
		defer closeQuietly(client)
		conn := &trackedConn{
			Conn: server, ctx: ctx, cancel: cancel, connections: &sync.Map{},
			incoming: make(chan connectionRead, 1), readWake: make(chan struct{}, 1),
		}
		defer closeQuietly(conn)
		var workers sync.WaitGroup
		workers.Go(conn.pump)
		if err := conn.SetReadDeadline(time.Now().Add(-time.Second)); err != nil {
			t.Fatal(err)
		}
		var buffer [4]byte
		_, err := conn.Read(buffer[:])
		var timeout net.Error
		if !errors.As(err, &timeout) || !timeout.Timeout() {
			t.Fatalf("wanted read timeout, got %v", err)
		}
		if ctx.Err() != nil {
			t.Fatal("HTTP hijack wakeup cancelled the connection")
		}
		if err := conn.SetReadDeadline(time.Time{}); err != nil {
			t.Fatal(err)
		}
		workers.Go(func() {
			if _, err := client.Write([]byte("next")); err != nil {
				t.Error(err)
			}
		})
		if _, err := io.ReadFull(conn, buffer[:]); err != nil {
			t.Fatal(err)
		}
		if string(buffer[:]) != "next" {
			t.Fatal("lost buffered bytes after deadline reset")
		}
		// No consumer read is pending: cancellation must still notice client EOF.
		closeQuietly(client)
		synctest.Wait()
		if ctx.Err() == nil {
			t.Fatal("missed a client disconnect during an idle stream")
		}
		workers.Wait()
	})
}
