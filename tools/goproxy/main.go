// Fluxy's HTTP transport. Policy stays in Electron; network I/O stays in goproxy.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type runtime struct {
	peer         *peer
	sessions     sync.Map
	connections  sync.Map
	sequence     atomic.Uint64
	transports   transportPool
	port         int
	ingressToken string
	ingressPort  int
}

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	p := newPeer(os.Stdout, cancel)
	r := &runtime{peer: p}
	go func() {
		if err := r.run(ctx, os.Stdin); err != nil && !errors.Is(err, io.EOF) {
			slog.Error("proxy runtime stopped", "error", err)
		}
		cancel()
	}()
	<-ctx.Done()
	r.connections.Range(func(_ any, value any) bool {
		closeQuietly(value.(net.Conn))
		return true
	})
	r.sessions.Range(func(_ any, value any) bool {
		value.(*session).finish(false, nil)
		return true
	})
	r.transports.close()
}

func (r *runtime) run(ctx context.Context, input io.Reader) error {
	start, err := readMessage(input)
	if err != nil {
		return err
	}
	if start.Type != "start" || start.Root == nil {
		return errors.New("expected start message with root identity")
	}
	r.ingressToken = start.IngressToken
	r.ingressPort = start.IngressPort
	proxy, err := r.proxy(*start.Root)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(start.Host, fmt.Sprint(start.Port)))
	if err != nil {
		return fmt.Errorf("listen for captured traffic: %w", err)
	}
	r.port = listener.Addr().(*net.TCPAddr).Port
	var prepare func(net.Conn) (net.Conn, error)
	if r.ingressToken != "" {
		prepare = r.prepareIngress
	}
	capture := newCaptureListener(ctx, listener, &r.connections, prepare)
	server := &http.Server{
		Handler:           flushHandler{proxy},
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       120 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	defer closeQuietly(server)
	go func() {
		if err := server.Serve(capture); err != nil && !errors.Is(err, http.ErrServerClosed) && ctx.Err() == nil {
			slog.Error("proxy listener stopped", "error", err)
			r.peer.fatal()
		}
	}()
	if err := r.peer.send(map[string]any{"type": "ready", "port": r.port}); err != nil {
		return err
	}
	for {
		msg, err := readMessage(input)
		if err != nil {
			return err
		}
		if msg.Type == "abort" {
			if value, ok := r.sessions.Load(msg.ID); ok {
				value.(*session).finish(false, nil)
			}
			continue
		}
		if err := r.peer.receive(msg); err != nil {
			return err
		}
	}
}

func closeQuietly(closer io.Closer) {
	// Cleanup must continue across already-closed sockets and cancelled streams.
	if closer != nil {
		if err := closer.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			slog.Debug("close proxy resource", "error", err)
		}
	}
}

type session struct {
	id             string
	runtime        *runtime
	cancel         context.CancelFunc
	done           <-chan struct{}
	once           sync.Once
	workers        sync.WaitGroup
	local          bool
	websocket      bool
	delivered      atomic.Bool
	disconnectOnce sync.Once
}

func (r *runtime) session(parent context.Context) (context.Context, *session) {
	// A client may close immediately after Content-Length bytes, before the last
	// capture credit arrives. Let that completed body drain before cancelling.
	ctx, cancel := context.WithCancel(context.WithoutCancel(parent))
	s := &session{
		id: fmt.Sprint(r.sequence.Add(1)), runtime: r, cancel: cancel, done: ctx.Done(),
	}
	r.sessions.Store(s.id, s)
	stop := context.AfterFunc(parent, s.disconnected)
	context.AfterFunc(ctx, func() { stop(); s.finish(false, nil) })
	return ctx, s
}

func (s *session) disconnected() {
	if !s.delivered.Load() {
		s.finish(false, nil)
		return
	}
	s.disconnectOnce.Do(func() {
		s.workers.Go(func() {
			timer := time.NewTimer(5 * time.Second)
			defer timer.Stop()
			select {
			case <-s.done:
			case <-timer.C:
				s.finish(false, errors.New("timed out draining captured response"))
			}
		})
	})
}

func (s *session) finish(completed bool, err error) {
	s.once.Do(func() {
		s.cancel()
		s.runtime.sessions.Delete(s.id)
		s.runtime.peer.removeStreams(s.id + ":")
		if err != nil && !errors.Is(err, context.Canceled) {
			if sendErr := s.runtime.peer.send(message{Type: "failure", ID: s.id, Error: err.Error()}); sendErr != nil {
				slog.Debug("send proxy failure", "error", sendErr)
			}
		}
		if sendErr := s.runtime.peer.send(map[string]any{
			"type": "closed", "id": s.id, "aborted": !completed,
		}); sendErr != nil {
			slog.Debug("send proxy close", "error", sendErr)
		}
	})
}

func (s *session) askBody(ctx context.Context, msg map[string]any, body io.ReadCloser, trailers func() http.Header) (message, error) {
	phase := msg["type"].(string)
	msg["id"] = s.id
	peer := s.runtime.peer
	replies, remove := peer.reply(phase + "-result:" + s.id)
	defer remove()
	if err := peer.send(msg); err != nil {
		return message{}, err
	}
	s.workers.Go(func() {
		if err := peer.pipe(ctx, s.id+":"+phase+":in", body, trailers); err != nil {
			s.finish(false, err)
		}
	})
	select {
	case <-ctx.Done():
		return message{}, ctx.Err()
	case result := <-replies:
		if result.Error != "" {
			return message{}, errors.New(result.Error)
		}
		return result, nil
	}
}
