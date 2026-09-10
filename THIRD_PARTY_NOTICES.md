# Third-Party Software Notices

This document describes the dependencies of Fluxy 0.1.0, checked against the
repository manifests and lockfiles on 2026-09-08. Original Fluxy contributions
use the [MIT License](LICENSE). Third-party components retain their own copyright
notices and license terms. This inventory does not replace their full license texts.

## Electron application

Exact npm versions and dependency resolution are recorded in
[package-lock.json](package-lock.json); direct dependencies are declared in
[package.json](package.json). The tables below cover direct dependencies only.
Transitive dependencies have their own licenses and notices, which must be
retained when distributing them.

### Runtime components (including bundled renderer code)

| Package                     | Locked version | License                   |
| --------------------------- | -------------- | ------------------------- |
| `@modelcontextprotocol/sdk` | 1.30.0         | MIT                       |
| `@peculiar/x509`            | 2.1.0          | MIT                       |
| `builder-util-runtime`      | 9.7.0          | MIT                       |
| `electron-updater`          | 6.8.9          | MIT                       |
| `ws`                        | 8.21.3         | MIT                       |
| `lucide-react`              | 0.577.0        | ISC                       |
| `node-forge`                | 1.4.0          | (BSD-3-Clause OR GPL-2.0) |
| `protobufjs`                | 8.8.0          | BSD-3-Clause              |
| `proxy-agent`               | 8.0.2          | MIT                       |
| `react`                     | 19.2.8         | MIT                       |
| `react-dom`                 | 19.2.8         | MIT                       |
| `reflect-metadata`          | 0.2.2          | Apache-2.0                |
| `zod`                       | 4.5.4          | MIT                       |

Lucide's license also includes MIT terms for portions derived from Feather:
copyright 2013–2026 Cole Bemis; other portions are copyright 2026 Lucide
Contributors. Preserve both parts of its license. Node Forge offers a choice of
BSD-3-Clause or GPL-2.0, as recorded above and in its package license.

The renderer uses locally maintained shadcn/ui components styled with Tailwind CSS. Their source is adapted from the official `new-york-v4` registry. The shadcn/ui MIT license is included at `resources/licenses/shadcn-ui.txt`. Bundled renderer dependency license texts (React, React DOM, Scheduler, Lucide, Radix Slot/Compose Refs, class-variance-authority, clsx and tailwind-merge), plus Tailwind CSS and tw-animate-css notices, are retained under `licenses/` in the app archive. These npm packages are build-time dependencies because their used code is compiled into the renderer.

### Development and packaging dependencies

| Package                | Locked version | License      |
| ---------------------- | -------------- | ------------ |
| `@electron/osx-sign`   | 2.7.0          | BSD-2-Clause |
| `@playwright/test`     | 1.63.0         | Apache-2.0   |
| `@types/node`          | 22.20.1        | MIT          |
| `@types/node-forge`    | 1.3.14         | MIT          |
| `@types/react`         | 19.2.18        | MIT          |
| `@types/react-dom`     | 19.2.7         | MIT          |
| `@types/ws`            | 8.18.1         | MIT          |
| `@vitejs/plugin-react` | 5.2.0          | MIT          |
| `electron`             | 44.2.0         | MIT          |
| `electron-builder`     | 26.15.3        | MIT          |
| `electron-vite`        | 5.0.0          | MIT          |
| `prettier`             | 3.9.6          | MIT          |
| `typescript`           | 5.9.3          | Apache-2.0   |
| `vite`                 | 7.3.6          | MIT          |
| `vitest`               | 4.1.11         | MIT          |

Electron is declared as a development dependency but its runtime is distributed
with the application. Preserve Electron's bundled `LICENSE` and
`LICENSES.chromium.html`, including the notices for Chromium, Node.js and their
third-party components. Build and test dependencies are listed for source-build
attribution; this table does not imply they are all shipped in the desktop app.

## Embedded goproxy transport

Fluxy embeds **goproxy v1.9.1** (`github.com/elazarl/goproxy`), distributed
under the BSD-3-Clause license, in sing-box's `fluxy-inspector` service.
The adapter source and dependency changes are supplied in
[the inspector patch](third_party/patches/sing-box/0003-fluxy-inspector-service.patch).
WebSocket framing uses `github.com/gobwas/ws` v1.4.0 (MIT), with
`github.com/gobwas/httphead` v0.1.0 and `github.com/gobwas/pool` v0.2.1 (MIT).
HTTP/2 and SOCKS routing use the pinned sing-box module's `golang.org/x/net`
and `golang.org/x/text` dependencies (BSD-3-Clause).

Every package includes `resources/core/sing-box.licenses.txt` with the license texts
for compiled dependencies and the Go runtime, and `resources/core/sing-box.build.json`
with engine versions, target, patch checksums and binary checksum. Dependency pins
are in upstream `go.mod`/`go.sum` plus the inspector patch.

Protocol tests additionally use `@grpc/grpc-js` (Apache-2.0),
`https-proxy-agent` (MIT) and `tsx` (MIT). These are development dependencies.

## Cross-platform Go Helper

The Helper source and module checksums are in [helper](helper).
Its dependencies are pinned in [go.mod](helper/go.mod) and
[go.sum](helper/go.sum).

| Component                       | Version                 | License                                               | Use                  |
| ------------------------------- | ----------------------- | ----------------------------------------------------- | -------------------- |
| Go runtime and standard library | Build toolchain version | BSD-3-Clause, plus component notices where applicable | All platforms        |
| `golang.org/x/sys`              | v0.47.0                 | BSD-3-Clause                                          | Platform system APIs |
| `github.com/Microsoft/go-winio` | v0.6.2                  | MIT                                                   | Windows named pipes  |

The macOS adapter uses Apple system frameworks through cgo. Linux and Windows
use their respective operating-system APIs. Apple frameworks are supplied by
macOS; they are not vendored SwiftPM dependencies.

[scripts/build-electron-helper.mjs](scripts/build-electron-helper.mjs) assembles the Go and
x/sys license texts, plus go-winio on Windows, into
`build/electron-helper/fluxy-helper.licenses.txt`. The package includes this file
under `helper/` on every platform, alongside the Helper binary and its manifest.

## Embedded transport core

The transport core is built from the sing-box submodule at
[third_party/sing-box](third_party/sing-box), using its `cmd/sing-box` CLI and the build profile
in [third_party/patches/sing-box](third_party/patches/sing-box).

- sing-box version: **1.14.0**.
- Pinned revision: `0b8995879f29a9b98ee027bc17b75e101445b238`.
- Pinned Go toolchain: `go1.27.1`.
- Build tags: `with_gvisor,with_fluxy`, selected by the transport-profile patch.

The version, revision and toolchain are recorded in [pin.json](third_party/patches/sing-box/pin.json). Module versions
and checksums are recorded in [go.mod](third_party/sing-box/go.mod) and
[go.sum](third_party/sing-box/go.sum). The pin identifies the upstream source revision.
Local modifications are carried as a reviewable patch series in
[third_party/patches/sing-box](third_party/patches/sing-box) rather than committed into the
submodule; the generated build manifest records each applied patch and its
SHA-256, and the notice bundle states that the build was modified. The series adds Fluxy transport extensions and helper lifecycle handling, and limits
compiled protocols to the capture transport profile. The third patch also embeds
the Fluxy goproxy inspection engine (MIT), whose notice is included in the patched
source and generated license bundle. Its dependencies retain their own licenses.

sing-box is copyright 2022 nekohasekai and is distributed under
**GPL-3.0-or-later**. Its [upstream license](third_party/sing-box/LICENSE) also
contains a restriction on using its name or implying association without prior
consent. The `github.com/sagernet/sing` dependency is also GPL-3.0-or-later.
The selected gVisor fork includes Apache-2.0 license text and additional
component notices. Other compiled dependencies retain their own licenses.

[scripts/build-sing-box.mjs](scripts/build-sing-box.mjs) collects available license,
copying, notice, copyright and patent files from the compiled package graph for
the selected target, including Go toolchain notices. The generated build manifest
records the module versions used. The notice bundle and provenance manifest are
packaged beside the executable:

| Platform      | Core executable     | License bundle                   | Build manifest                 |
| ------------- | ------------------- | -------------------------------- | ------------------------------ |
| macOS / Linux | `core/sing-box`     | `core/sing-box.licenses.txt`     | `core/sing-box.build.json`     |
| Windows       | `core/sing-box.exe` | `core/sing-box.exe.licenses.txt` | `core/sing-box.exe.build.json` |

Paths are relative to the packaged application's resources directory
(`Contents/Resources` on macOS, `resources` on Linux and Windows). Retain the
license bundles, pinned source, local modifications, checksums and
build instructions with the corresponding release. The MIT license for original
Fluxy contributions does not replace the licenses of the embedded core.

## Historical Rockxy attribution

Fluxy originated from the Rockxy project. Historical attribution is:

Copyright 2024–2026 Nguyen Huu Loc (also known publicly as Stephen) and Rockxy
Contributors.

The original Swift application, Xcode project and SwiftPM dependency tree have
been removed from the current build. Any retained Rockxy-derived material remains
subject to its original AGPL-3.0-or-later terms and attribution; the Fluxy MIT
license does not relicense it. The Rockxy name, logos and product identity do not
imply endorsement or trademark permission for Fluxy.
