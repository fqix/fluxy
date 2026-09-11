# sing-box for Fluxy

Fluxy builds the upstream `cmd/sing-box` CLI with a reduced transport profile as
`sing-box` (`sing-box.exe` on Windows). The source revision and Go toolchain are
pinned in [pin.json](pin.json). All integration and protocol selection changes
are carried as patches; the build script has no protocol allowlist.

## Patch series

`0001-fluxy-transport.patch` contains only Fluxy's required integration:

- Register `fluxy-mixed` and `fluxy-inspect` alongside the existing upstream
  protocols. They preserve the HTTP stream and original client endpoint when
  forwarding traffic to Fluxy's authenticated inspection service.
- Shut down when the owning helper exits or its stdin pipe closes, and release
  partially started listeners and TUN resources on startup failure.
- Test the inspection wire format and coexistence with upstream protocols.

`0002-fluxy-transport-profile.patch` selects `with_gvisor,with_fluxy` and excludes
upstream protocol registration files from this build. It retains the upstream
registry API with only these capabilities:

| Capability | Retained                              |
| ---------- | ------------------------------------- |
| Inbounds   | TUN, HTTP, SOCKS, direct, fluxy-mixed |
| Outbounds  | direct, HTTP, SOCKS, fluxy-inspect    |
| DNS        | local, FakeIP, UDP, TCP, TLS, HTTPS   |
| TUN stack  | gVisor                                |

VMess, VLESS, Shadowsocks, Trojan, Hysteria, TUIC, WireGuard, Tailscale, SSH,
AnyTLS, selectors, URL tests, Clash/V2Ray APIs and optional services are excluded.
The upstream run/check/version/configuration CLI and core lifecycle remain intact.
Unused API-client commands and WireGuard key generation are excluded too, so they
do not pull removed protocol dependencies back into the binary. Tests reject excluded protocol,
endpoint and service configurations while accepting Fluxy's capture configuration.
The unmodified source files stay in the pinned submodule and are not compiled into
this profile. There is no separate wrapper module.

`0003-fluxy-inspector-service.patch` embeds the goproxy engine and adds the
`fluxy-inspector` service. `fluxy-inspect` can reference its service tag to hand off
connections in memory, without a TCP inspection listener. The patch includes the
engine source, its MIT notice, dependency pins, and HTTP/HTTPS/IPC lifecycle tests.
There is no separate inspection module or binary to build.

See [inspector.example.json](inspector.example.json) for configuration. The service
requires a Fluxy controller on inherited stdin/stdout: send the existing framed
`start` message with `root: {certificate, key}` and `ingressPort`, then handle the
existing policy and body-stream messages. The ready response adds `in_process:true`.
Logs must use stderr. EOF requests instance shutdown; SIGHUP reload is declined.
The service's full documentation is included in the patch at
`service/fluxyinspector/README.md`.

Electron starts this service in its capture sing-box process and uses the service-tag
outbound configuration. The same process owns the public listener and inspection;
there is no separate inspection process or private inspection TCP port. TUN capture uses one privileged Helper-owned instance containing both TUN and
inspection. Electron attaches through an authenticated Helper IPC relay instead
of starting its own core. The route to `fluxy-inspect` stays in process.

`0004-network-startup-race.patch` uses an atomic startup flag in the upstream
network manager. Its interface monitor runs asynchronously during startup; this
prevents the race detected when running the combined process with `-race`.

`0005-fluxy-http3.patch` adds QUIC/HTTP/3 interception to the embedded inspector
using the already pinned `github.com/sagernet/quic-go` module. Routed UDP flows
retain their client identity and actual destination, including Alt-Svc ports.
The existing CA, custom certificates, IPC body streams, rules, scripts and
breakpoints also handle HTTP/3. The reduced protocol registry stays in place;
enabling HTTP/3 inspection does not enable unrelated QUIC proxy protocols.

HTTP/3 requires TUN or a client using SOCKS5 UDP, a trusted Fluxy CA and a matching
SSL inspection host. Excluded hosts pass through encrypted. In TUN mode, the
inspector's `packet_egress: direct` uses the same bound-interface or SOCKS outbound
as the rest of the core. In ordinary proxy mode, a configured upstream HTTP/SOCKS
proxy carries decrypted requests over HTTP/2 or HTTP/1.1; native H3 egress is used
when there is no upstream proxy. Extended CONNECT/WebTransport and 0-RTT acceptance
are not implemented. The legacy separate TCP inspection bridge still rejects
UDP 443; the Helper's combined process supports H3.

### HTTP/3 client setup

Clients must send UDP through TUN or support SOCKS5 UDP ASSOCIATE. A system HTTP
proxy alone does not carry native HTTP/3. QUIC flows advertising `h3` use the
inspection policy; other QUIC ALPNs pass through encrypted in TUN mode.

Chrome/Chromium normally rejects QUIC certificates issued by user-installed CAs,
even when those CAs are trusted for HTTPS. This can cause fallback to HTTP/2.
See [Chromium's QUIC documentation](https://www.chromium.org/quic/playing-with-quic/).
Current Chromium source permits trusted local roots for hosts selected by
`--origin-to-force-quic-on` ([session pool](https://chromium.googlesource.com/chromium/src/+/HEAD/net/quic/quic_session_pool.cc),
[proof verifier](https://chromium.googlesource.com/chromium/src/+/HEAD/net/quic/crypto/proof_verifier_chromium.cc)).
For a controlled Google test, use a separate browser profile, trust the Fluxy CA
for that browser, enable TUN and SSL inspection for `www.google.com`, and launch
Chrome with `--user-data-dir=<separate-test-profile> --no-proxy-server
--enable-quic --origin-to-force-quic-on=www.google.com:443`. Certificate validation
still applies. This behavior is version-dependent and has not been validated
against a live Chrome/TUN session here; the automated suite uses a Go HTTP/3 client.
Check the browser's Network protocol column for `h3`; an `Alt-Svc: h3=...` response
advertises server support but does not prove the current request used HTTP/3.

`0006-socks-udp-race.patch` binds SOCKS5 UDP replies to the client learned from the
first packet before concurrent QUIC reads and writes begin. This avoids the pinned
sing adapter's unsynchronized reply-address updates, while preserving the first
packet cache, idle timeout and TCP control connection ownership. Its full-duplex
UDP regression test runs with the core's race checks.

## Build and test

```sh
git submodule update --init third_party/sing-box
npm run core:build
npm run sing-box:test
npm run test:protocol:h3
build/electron-core/sing-box version
# Optional universal macOS build:
node scripts/build-sing-box.mjs --arch arm64 --arch x86_64
```

[scripts/build-sing-box.mjs](../../../scripts/build-sing-box.mjs) applies the patch
series directly to `third_party/sing-box` and compiles that working directory.
`npm run dev` runs this build through `predev`, so local source edits participate
in subsequent builds. Temporary directories hold only build outputs and patch
preflight copies; the patched source remains in the submodule.

The script recognizes an already applied series, including overlapping patches,
and records its checksums in the submodule's Git directory. Repeated builds keep
local edits. A changed patch series requires reconciling the source and removing
the receipt named in the error; conflicts stop before applying patches. The script
never resets or cleans the source. Compilation uses Go's own cache.

Tests run against patched `include`, `cmd/sing-box`, and the embedded inspector
packages with the race detector (except Windows ARM64), followed by vet.
`FLUXY_CORE_RACE=1 npm run test:protocol` also checks the live protocol engine with
the race detector.

Each build produces the executable, `.build.json` and `.licenses.txt`. The manifest
records upstream tags, module versions, patch checksums and the binary checksum.
Electron packages these under `core/`; macOS signing refreshes the signed checksum.
Output defaults to `build/electron-core/sing-box` (`sing-box.exe` on Windows).
`FLUXY_BUILD_PLATFORM`, `FLUXY_BUILD_ARCH`, and `FLUXY_CORE_RACE` provide build
defaults; explicit CLI options take precedence. Use `--output` for another location.
Go must be on PATH, or selected with `FLUXY_GO`.

## Updating patches

Edit the patched submodule for development. Use a separate checkout at the pinned
commit when regenerating the individual patches so local changes are not lost.
Export a plain Git diff including added files into `NNNN-description.patch`.
Rebase the patches when updating `pin.json`, then run Go and Electron tests.
Never commit Fluxy changes into the upstream submodule pointer.

See [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md) for source and notices.
