# Privileged helper platforms

Fluxy uses the same authenticated, newline-delimited JSON RPC protocol on all three desktop platforms.

| Platform | Implementation | Installation | Local transport |
| --- | --- | --- | --- |
| macOS 13+ | `platform_darwin.go` | launchd, administrator authorization | Unix socket and Security.framework audit-token caller verification |
| Linux with systemd | Go in this directory | systemd, `pkexec` | Unix socket, paired UID and executable hash |
| Windows 10/11 | Go in this directory | Windows service, UAC | Named pipe, paired SID and executable hash |

The Go helper accepts only status, typed TUN start/stop, and install/remove of a self-signed Fluxy root CA. It generates its own core configuration. It never accepts executable paths, shell commands, or arbitrary configuration files over RPC. Installation verifies staged binary and pairing checksums after copying into an administrator-owned directory. The application keeps a random pairing token in its private data directory.

One connection owns the TUN session. Disconnect or 20 seconds without a request stops its core. Core stdin EOF requests graceful shutdown, including when the helper crashes; Windows additionally uses a job object. Normal service stop also waits for the core to close. Application updates that change the paired executable require Helper repair. Linux AppImage remounts are accepted only when the paired executable checksum still matches.

Linux requires systemd, polkit (`pkexec` and a desktop authentication agent), `iproute2`, `/dev/net/tun`, `openssl`, and the distribution's `ca-certificates` package. Automatic CA installation supports Debian/Ubuntu's `update-ca-certificates` and Fedora/RHEL's `update-ca-trust`. Other trust-store layouts need manual certificate import. Windows uses the LocalMachine Root store. The pinned sing-tun dependency embeds its architecture-specific Wintun driver; no runtime download is needed. Applications with private certificate stores may still require manual import.

## Build and verify

From the repository root, `npm run core:build` builds the native host target. `FLUXY_BUILD_PLATFORM=linux|win32|darwin` and `FLUXY_BUILD_ARCH=x64|arm64` select another target. All helpers are built with Go. macOS uses cgo to call Security.framework for audit-token/signature verification and exact system keychain access; it requires macOS and Xcode Command Line Tools, but no Swift compiler. Linux and Windows use CGO_ENABLED=0. Windows build output names include `.exe`; package resources and integrity manifests use the same names. Python 3.10+ and Go are needed for the transport core on every build host. `FLUXY_PYTHON` and `FLUXY_GO` override executable discovery.

```sh
cd tools/helper
go test -race ./...
go vet ./...
GOOS=linux GOARCH=amd64 go build -o /tmp/fluxy-helper-linux .
GOOS=windows GOARCH=amd64 go build -o /tmp/fluxy-helper.exe .
```

Tests use temporary sockets/pipes, generated certificates, and a harmless child-process fixture. They do not install services, change system trust, or create TUN interfaces. CI runs the test/build/package matrix on macOS, Linux and Windows. Successful cross-compilation alone does not validate UAC/polkit prompts, service ACLs, live TUN routing, or restoration on those operating systems; these require native desktop acceptance testing.
