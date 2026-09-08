# Fluxy goproxy transport

Fluxy uses `github.com/elazarl/goproxy` v1.9.1 for HTTP/HTTPS interception,
HTTP/2 and streaming gRPC. The Go process owns sockets and TLS; Electron retains
session storage, process attribution, rules, scripts, breakpoints, custom
certificates and network conditions. No separate Go installation is needed to
run a packaged application.

## Build and packaging

```sh
npm run proxy:build
cd tools/goproxy
go test -race ./...
go vet ./...
```

`go.mod` and `go.sum` pin upstream dependencies. `build.mjs` builds with
`-mod=readonly`, `CGO_ENABLED=0`, and the same `FLUXY_BUILD_PLATFORM` /
`FLUXY_BUILD_ARCH` targets as the desktop core (macOS, Linux and Windows,
x64 and ARM64). `FLUXY_GO` can select the Go toolchain.
`FLUXY_PROXY_RACE=1 npm run test:protocol` additionally checks the actual Go
transport for data races (native targets with race-detector support only).

`core:build`, development and tests build the proxy automatically. Electron
packages `build/goproxy/fluxy-proxy[.exe]` under `resources/proxy`, alongside
`manifest.json` and `licenses.txt`. The manifest records the engine version,
platform, architecture and binary/module checksums. macOS signing refreshes the
signed binary checksum before sealing the application bundle.

## Policy and streams

The process accepts HTTP proxy and SOCKS5 CONNECT on one listening port.
CONNECT inspection follows Fluxy's SSL Proxying rules; bypassed tunnels retain
the existing main-process routing and attribution path. Interception uses
Fluxy's current root CA or matching custom server identity. Upstream TLS
verification stays enabled, including configured CA and client certificates.

Inherited stdin/stdout carry length-prefixed JSON with base64 binary values.
There is no separate control listener. Request and response bodies use a
credit-based stream with at most one 64 KiB chunk in flight per direction.
Paused consumers stop producers while other HTTP/2 streams and cancellation
messages continue. Body capture limits do not truncate forwarded traffic.

SSE and gRPC stay live; their breakpoints pause at headers and preserve bodies.
Whole-body scripts are skipped for these streaming content types. Per-message
Protobuf editing is not implemented. Response trailers remain available in
sessions and the Trailers inspector tab.

WebSocket forwarding uses `gobwas/ws` to validate frames, preserve data-frame
boundaries, masking, text/binary flags and control frames, and apply Fluxy's
message capture and pacing hooks. Compression negotiation is disabled on this
path. Message size is capped at 100 MiB and fragmentation at 65,536 frames.

The HTTP library normalizes header casing/order. Duplicate values are retained;
captured header entries do not claim to reproduce the original wire order.

## Regression checks

```sh
npm test
npm run test:protocol
# Optional public go-httpbin / grpcbin comparison:
npm run test:protocol:public
```

The local tests exercise the production ProxyEngine: binary bodies, SOCKS5,
custom CA and mTLS, mapping, scripts, header/body breakpoints, cancellation,
bandwidth shaping, WS/WSS fragmentation, and gRPC/gRPCS unary, client streaming,
server streaming, bidirectional streaming and trailers-only errors.

CI runs Go tests/vet and the local protocol gate on native build targets, with
race detection except on Windows ARM64, where Go does not support it.
Public checks write `test-results/protocol/goproxy-public.json`; unavailable
direct controls are reported separately and do not count as proxy passes.
