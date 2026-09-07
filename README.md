# Fluxy

Fluxy is a network inspection desktop app built with **Electron, TypeScript and React**.

[简体中文](README.zh.md) · [User and development guide](ELECTRON.md) · [Release setup](ELECTRON_RELEASE.md)

## One-click installation

Download and install the latest published release using the command for your platform.

The release matrix covers **macOS ARM64, Linux x64/ARM64, and Windows x64/ARM64**. Linux produces deb and rpm packages. ARM32 is not configured.

### macOS / Linux

```sh
curl --fail --location https://raw.githubusercontent.com/fqix/fluxy/main/install.sh | bash
```

On macOS, the app is installed to `~/Applications/Fluxy.app`. On Linux, the script selects **deb or rpm** for your package manager and requests sudo when installing. No AppImage is used.

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/fqix/fluxy/main/install.ps1 | iex
```

Run the command in PowerShell as your desktop user. It downloads and silently installs Fluxy for the current user.

Both scripts select the architecture and verify SHA-256. Matching packages and checksum files must be published first. See [installation options and release requirements](tools/install/README.md) for a specific version or a dry run, or inspect the scripts: [macOS / Linux](install.sh) · [Windows](install.ps1).

## Develop

```sh
git submodule update --init third_party/sing-box
npm ci
npm run dev
```

Use Node.js 22.12+ and npm. All builds need Python 3.10+ and Go for the transport core and helper; macOS also needs Xcode Command Line Tools. No Rockxy application, Xcode project or SwiftPM dependency tree is required. The packaged application includes these runtime components.

## Features

- HTTP/HTTPS capture, WebSocket inspection, system proxy integration and TUN capture on macOS, Linux and Windows.
- Application attribution, advanced filtering, projects, sessions and HAR interchange.
- Request/response breakpoints, mapping and header rules, network condition presets and bandwidth shaping.
- Request/response/timing and text Diff, comparison history, pinning and export.
- Certificate tools, request composition, scripting, Protobuf/gRPC inspection and MCP.
- Automatic update checks/downloads with an explicit restart/install action. Production updates require signed published packages.

The AI assistant has been removed. See [feature coverage and limits](ELECTRON.md).

### TUN compatibility

Fluxy's current TUN mode conflicts with Clash and sing-box. Before enabling Fluxy TUN, disable TUN mode in those applications or quit them. Avoid running their TUN modes simultaneously.

## Verify and package

```sh
npm run typecheck
npm run format:check
npm test
npm run test:e2e
npm run package
npm run dist
```

Tests use local servers and temporary storage. Real system proxy changes, certificate trust, privileged helper installation and TUN routing require explicit application actions. Helper installation, TUN, certificate trust and packaging have platform implementations for macOS, Linux and Windows. Native Linux/Windows privilege and routing acceptance tests are still required; see [platform requirements](tools/helper/README.md).

## Layout

| Path                                     | Purpose                                                     |
| ---------------------------------------- | ----------------------------------------------------------- |
| `src/main`                               | Electron lifecycle, proxy, persistence, native integrations |
| `src/preload`                            | Validated renderer bridge                                   |
| `src/renderer`                           | React desktop UI                                            |
| `src/shared`                             | Models, schemas and shared logic                            |
| `tools/helper`                           | Cross-platform Go privilege helper                          |
| `tools/sing-box`, `third_party/sing-box` | Pinned transport core and build tooling                     |
| `tests`                                  | Unit, integration and Electron desktop tests                |
| `resources`                              | Fluxy icons and redistribution notices                      |

## License and attribution

Original Fluxy contributions use the [MIT License](LICENSE). Third-party and
Rockxy-derived material retain their original licenses; this change does not
relicense them. See [copyright and scope](COPYRIGHT.md) and
[third-party notices](THIRD_PARTY_NOTICES.md).
