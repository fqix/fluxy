# Fluxy embedded transport core

The application embeds **sing-box 1.14.0** as an independent executable named
`fluxy-core` (`fluxy-core.exe` on Windows). The unmodified upstream source is a Git submodule at
`third_party/sing-box`, pinned to `0b8995879f29a9b98ee027bc17b75e101445b238`.
The build checks both the revision and a clean submodule worktree. It never
tracks the upstream branch or downloads a prebuilt runtime binary.

## Build profile

The small Go entry point in this directory uses sing-box's public `box.Context`
and `box.New` APIs with explicit registries. It does **not** import upstream
`include.Context` or the full `cmd/sing-box` CLI. Disabling optional build tags
alone would still register many unused protocols through `include`.

| Area | Included |
| --- | --- |
| Inbounds | TUN, HTTP, SOCKS, Fluxy mixed HTTP/SOCKS, Direct (local DNS testing) |
| Outbounds | Direct, HTTP CONNECT, SOCKS, private Fluxy inspection bridge |
| DNS transports | Local, UDP, TCP, TLS, HTTPS, Fake IP |
| TUN stack | gVisor (`with_gvisor`) and upstream system stack support |
| Routing | Shared upstream routing and HTTP/TLS sniffing used by the Electron bridge |
| CLI | `version`, `check -c CONFIG`, `run -c CONFIG` |

No proxy registries for VMess, VLESS, Shadowsocks, Trojan, Hysteria, TUIC,
WireGuard, Tailscale, SSH, AnyTLS, selectors or URL tests are included. Endpoint,
service, and certificate-provider registries are empty. Clash/V2Ray management
servers and optional uTLS/QUIC/ACME transports are not enabled. Shared upstream
routing, option types, TLS, sniffers, and infrastructure remain; this is not a
rewrite or a claim that every unused upstream symbol has been removed.
The build checks the compiled dependency graph for excluded protocol/API
packages and verifies that gVisor is present.

The CLI intentionally does not implement upstream commands for subscriptions,
key generation, formatting, configuration directories, or SIGHUP reloads.
SIGINT/SIGTERM cancel and close the core; shutdown has a 10-second deadline.
A hung core is force-exited after that deadline, so this is not a substitute for
product-level privileged-helper recovery.

## Setup and standalone build

```sh
git submodule update --init third_party/sing-box
python3 tools/sing-box/build.py --arch arm64 --arch x86_64
build/fluxy-core version
```

Use `--platform linux` or `--platform windows` and one `--arch` to cross-compile. Windows outputs should end in `.exe`.

Install Go first. The script selects **Go 1.27.1** via `GOTOOLCHAIN`; Go may
download that pinned toolchain if the local installation differs. The build can find
Go on PATH, in common Homebrew/official-install locations, or through `FLUXY_GO`.
Dependencies are recorded in `go.mod` / `go.sum`; builds use `-mod=readonly`,
`-trimpath`, `-buildvcs=false`, `CGO_ENABLED=0`, and stripped symbols. Downloads
are limited to source dependencies/toolchain setup. No Go runtime installation
is required on the machine running the finished app.

Standalone output:

- `build/fluxy-core`: native executable (Mach-O, ELF, or Windows PE). Only macOS supports a universal binary.
- `build/fluxy-core.build.json`: revision, version, toolchain, tags, architectures,
  dependency modules, and checksum of the binary before app signing.
- `build/fluxy-core.licenses.txt`: collected upstream, dependency, and Go notices.

Only the requested architectures are compiled. Go's build cache and a
source/profile fingerprint cache avoid recompilation when inputs have not
changed. Cached artifacts are checksum-validated. Generated binaries are ignored
by Git; only source, the submodule pointer, build configuration, and checksums
belong in the repository.

## Electron packaging

`npm run core:build` builds `build/electron-core/fluxy-core` and its provenance
and license files. `package.json` places these in `Contents/Resources/core/`.
On macOS, `tools/sign-electron.cjs` signs the executable, refreshes the binary checksum
in the manifest and re-seals the application before notarization.

In system proxy mode, `src/main/capture/sing-box-proxy.ts` starts the core directly without elevation. `fluxy-mixed` delegates SOCKS handshakes to sing-box and forwards HTTP as an unchanged stream, preserving WebSocket upgrades and cancellation. `fluxy-inspect` sends an authenticated CONNECT envelope to the internal inspection engine, retaining the original client endpoint. This mode rejects UDP. The public port remains compatible with existing HTTP/HTTPS system proxy settings and SOCKS5 clients.

For TUN, the transport core is started by the cross-platform Go helper and managed
by `src/main/tun/tun.ts`. The former Xcode embedding mode and Python TUN prototype
have been removed. See [helper platform requirements](../../tools/helper/README.md).

## Validate

```sh
cd tools/sing-box
GOTOOLCHAIN=go1.27.1 CGO_ENABLED=0 go test -mod=readonly -tags=with_gvisor ./...
GOTOOLCHAIN=go1.27.1 CGO_ENABLED=0 go vet -mod=readonly -tags=with_gvisor ./...
go mod verify
```

The Electron integration tests in `tests/unit/tun.test.ts` exercise HTTP, HTTPS,
UDP and supervised shutdown using rootless local listeners.
