// HTTP/3 protocol fixture, built in the pinned core module by http3.ts.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/sagernet/quic-go"
	"github.com/sagernet/quic-go/http3"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
	"github.com/sagernet/sing/protocol/socks"
)

var outputMu sync.Mutex

func output(value any) {
	outputMu.Lock()
	defer outputMu.Unlock()
	_ = json.NewEncoder(os.Stdout).Encode(value)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) > 1 {
		return request()
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"}, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return err
	}
	packets, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer packets.Close()
	quicListener, err := quic.ListenAddr("127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, NextProtos: []string{"fluxy-test"}}, nil)
	if err != nil {
		return err
	}
	defer quicListener.Close()
	go func() {
		conn, err := quicListener.Accept(context.Background())
		if err != nil {
			return
		}
		defer conn.CloseWithError(0, "finished")
		stream, err := conn.AcceptStream(context.Background())
		if err != nil {
			return
		}
		data, err := io.ReadAll(stream)
		if err != nil {
			return
		}
		_, _ = stream.Write(data)
		_ = stream.Close()
		<-conn.Context().Done()
	}()
	server := &http3.Server{TLSConfig: &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			return
		}
		output(map[string]any{"type": "request", "path": r.URL.Path, "body": body, "headers": r.Header, "version": r.Proto})
		if r.URL.Path == "/cancel" {
			_, _ = w.Write([]byte("first"))
			_ = http.NewResponseController(w).Flush()
			<-r.Context().Done()
			output(map[string]any{"type": "cancelled", "path": r.URL.Path})
			return
		}
		w.Header().Set("Trailer", "X-Finished")
		w.Header().Set("X-Origin-Request-Edit", r.Header.Get("X-Test"))
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(body)
		w.Header().Set("X-Finished", "yes")
	})}
	defer server.Close()
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); _ = server.Close() }()
	output(map[string]any{"type": "ready", "port": packets.LocalAddr().(*net.UDPAddr).Port, "quicPort": quicListener.Addr().(*net.UDPAddr).Port, "ca": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))})
	return server.Serve(packets)
}

func request() error {
	if len(os.Args) != 6 {
		return fmt.Errorf("request requires proxy, URL, CA file and base64 body")
	}
	ca, err := os.ReadFile(os.Args[4])
	if err != nil {
		return err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca) {
		return fmt.Errorf("invalid CA")
	}
	dialer := socks.NewClient(N.SystemDialer, M.ParseSocksaddr(os.Args[2]), socks.Version5, "", "")
	if os.Args[1] == "quic" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		packets, err := dialer.DialContext(ctx, "udp", M.ParseSocksaddr(os.Args[3]))
		if err != nil {
			return err
		}
		defer packets.Close()
		conn, err := quic.DialConn(ctx, packets, &tls.Config{RootCAs: roots, ServerName: "localhost", NextProtos: []string{"fluxy-test"}}, nil)
		if err != nil {
			return err
		}
		defer conn.CloseWithError(0, "finished")
		stream, err := conn.OpenStreamSync(ctx)
		if err != nil {
			return err
		}
		data, err := base64.StdEncoding.DecodeString(os.Args[5])
		if err != nil {
			return err
		}
		if _, err = stream.Write(data); err != nil {
			return err
		}
		if err = stream.Close(); err != nil {
			return err
		}
		data, err = io.ReadAll(stream)
		if err != nil {
			return err
		}
		output(map[string]any{"body": data})
		return nil
	}
	transport := &http3.Transport{TLSClientConfig: &tls.Config{RootCAs: roots}, Dial: func(ctx context.Context, address string, config *tls.Config, qc *quic.Config) (*quic.Conn, error) {
		packets, err := dialer.DialContext(ctx, "udp", M.ParseSocksaddr(address))
		if err != nil {
			return nil, err
		}
		conn, err := quic.DialConn(ctx, packets, config, qc)
		if err != nil {
			_ = packets.Close()
			return nil, err
		}
		context.AfterFunc(conn.Context(), func() { _ = packets.Close() })
		return conn, nil
	}}
	defer transport.Close()
	body, err := base64.StdEncoding.DecodeString(os.Args[5])
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", os.Args[3], strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	if os.Args[1] == "get" {
		req.Method = "GET"
	}
	resp, err := (&http.Client{Transport: transport}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if strings.HasSuffix(os.Args[3], "/cancel") {
		data := make([]byte, 5)
		if _, err := io.ReadFull(resp.Body, data); err != nil {
			return err
		}
		output(map[string]any{"body": data, "status": resp.StatusCode, "version": resp.Proto})
		return nil
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	output(map[string]any{"body": data, "status": resp.StatusCode, "headers": resp.Header, "trailers": resp.Trailer, "version": resp.Proto})
	return nil
}
