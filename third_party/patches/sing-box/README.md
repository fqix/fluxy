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
there is no separate inspection process or private inspection TCP port. TUN capture
keeps its privileged TUN instance and bridge, with inspection in the unprivileged
capture instance.

`0004-network-startup-race.patch` uses an atomic startup flag in the upstream
network manager. Its interface monitor runs asynchronously during startup; this
prevents the race detected when running the combined process with `-race`.

## Build and test

```sh
git submodule update --init third_party/sing-box
npm run core:build
npm run sing-box:test
build/electron-core/sing-box version
# Optional universal macOS build:
node scripts/build-sing-box.mjs --arch arm64 --arch x86_64
```

[scripts/build-sing-box.mjs](../../../scripts/build-sing-box.mjs) exports the pinned
commit into a unique temporary directory under `build/`, applies patches in
filename order, builds, and removes that directory. Local submodule edits remain
untouched. Compilation uses Go's own cache; no additional binary cache or lock is
maintained. Tests run against patched `include`, `cmd/sing-box`, and the embedded inspector
packages with the race detector (except Windows ARM64), followed by vet.
`FLUXY_CORE_RACE=1 npm run test:protocol` also checks the live protocol engine with
the race detector.

Each build produces the executable, `.build.json` and `.licenses.txt`. The manifest
records upstream tags, module versions, patch checksums and the binary checksum.
Electron packages these under `core/`; macOS signing refreshes the signed checksum.
Standalone output defaults to `build/sing-box` (`build/sing-box.exe` on Windows).
Go must be on PATH, or selected with `FLUXY_GO`.

## Updating patches

Use a separate checkout at the pinned commit, apply the series, and edit there.
Export a plain Git diff including added files into `NNNN-description.patch`.
Rebase the patches when updating `pin.json`, then run Go and Electron tests.
Never commit Fluxy changes into the upstream submodule pointer.

See [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md) for source and notices.
