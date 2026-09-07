# Fluxy Whistle transport

Fluxy uses Whistle 2.10.9 as its production HTTP/HTTPS and HTTP/2 transport.
Whistle runs in a child process because upstream patches Node globals and owns
long-lived timers. WebSocket forwarding in that child uses `ws`; TLS interception
and certificate selection are supplied by Whistle.

## Source and build

```sh
git submodule update --init --recursive
npm ci
npm run whistle:build
```

`third_party/whistle` must be clean and match `pin.json`. `build.mjs` copies it
to `build/whistle/upstream`, checks and applies `patches/*.patch`, installs the
runtime dependencies with `npm ci --ignore-scripts`, and bundles `child.ts`.
The upstream checkout is never patched. `package-lock.json` fixes the runtime
dependency graph. `manifest.json` records the revision and checksums for patches,
the lockfile, generated source, installed dependencies and the child entrypoint.

`core:build`, development, tests and packaging build this runtime automatically.
Electron packages it under `resources/whistle` on macOS, Linux and Windows,
including x64 and ARM64 builds. No separately installed Node or Whistle is needed.
The embedded runtime disables Whistle's Web UI and plugins; Fluxy is its control
surface. Upstream TLS verification remains enabled.

## Policy and streams

`src/main/capture/whistle-transport.ts` connects Whistle to Fluxy's existing
`ProxyEngine`. Fluxy retains session storage, source-process attribution, rules,
custom certificates, mapping, breakpoints, scripts and network conditions. The
child receives only the current request's routing/policy decisions, so changing
a rule or upstream setting does not require restarting capture.

Request and response bodies use a credit-based IPC stream with 64 KiB chunks.
A paused consumer stops the producer; SSE and gRPC are not collected to EOF
before forwarding. Capture storage remains capped at 2 MiB per body. WebSocket
messages preserve text/binary flags and direction, and honor Fluxy's frame pacing.
Closing a client or stopping capture cancels the upstream operation.

For gRPC and SSE, breakpoints pause at headers and preserve the live body.
Whole-body scripts are skipped for these streaming content types, with a log
entry: waiting for EOF would deadlock a bidirectional or indefinite stream.
Per-message Protobuf editing is not implemented. Ordinary HTTP body scripts and
request/response edits retain their existing bounded-buffer behavior.

Response trailers are retained in sessions and shown in the response **Trailers**
tab. The HTTP/2 patch preserves gRPC error status and metadata when an upstream
returns a trailers-only response through Whistle's internal HTTP/1 conversion.

## Regression checks

```sh
npm test
npm run test:protocol
npm run test:protocol:public
```

The local suite in `tests/protocol` exercises the actual production `ProxyEngine`:
HTTP/HTTPS binary bodies and CA verification; SSE first-event delivery, live
capture and cancellation; WS/WSS bidirectional text/binary frames; gRPC and gRPCS
unary, client streaming, server streaming, bidirectional streaming, trailers-only
errors, cancellation and header breakpoints without buffering streams to EOF.
CI and release builds run the local protocol gate on each native build target.

The optional public suite compares direct and proxied requests against
go-httpbin (`httpbingo.org`) and grpcbin (`grpcb.in:9000` / `:9001`). An unavailable
direct control is reported separately and is not counted as a proxy pass.
Results are written to `test-results/protocol/`. External service availability
does not gate releases.
