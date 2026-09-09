# Privileged helper platforms

Fluxy uses the same authenticated, newline-delimited JSON RPC protocol on all three desktop platforms.

| Platform | Implementation | Installation | Local transport |
| --- | --- | --- | --- |
| macOS 13+ | `platform_darwin.go` | launchd, administrator authorization | Unix socket and Security.framework audit-token caller verification |
| Linux with systemd | Go in this directory | systemd, `pkexec` | Unix socket, paired UID and executable hash |
| Windows 10/11 | Go in this directory | Windows service, UAC | Named pipe, paired SID and executable hash |

The Go helper accepts only status, typed TUN start/stop, and install/remove of a self-signed Fluxy root CA. It generates its own core configuration. It never accepts executable paths, shell commands, or arbitrary configuration files over RPC. Installation verifies staged binary and pairing checksums after copying into an administrator-owned directory. The application keeps a random pairing token in its private data directory.

One connection owns the TUN session. Disconnect or 20 seconds without a request stops its core. Core stdin EOF requests graceful shutdown, including when the helper crashes; Windows additionally uses a job object. Normal service stop also waits for the core to close. Application updates that change the paired executable require Helper repair.

Linux requires systemd, polkit (`pkexec` and a desktop authentication agent), `iproute2`, `/dev/net/tun`, `openssl`, and the distribution's `ca-certificates` package. Automatic CA installation supports Debian/Ubuntu's `update-ca-certificates` and Fedora/RHEL's `update-ca-trust`. Other trust-store layouts need manual certificate import. Windows uses the LocalMachine Root store through Crypt32. Windows Helper setup, repair, removal, SID lookup, certificate writes, and certificate status checks do not invoke PowerShell, cmd, or scripts. The bundled helper calls ShellExecuteExW for UAC and Service Control Manager APIs for service lifecycle. Setup accepts a typed action and pinned hashes, creates the protected staging directory with a native security descriptor, and reports errors over a private named pipe. Existing files are retained for rollback until service startup succeeds. UAC consent is still required. The pinned sing-tun dependency embeds its architecture-specific Wintun driver; no runtime download is needed. Applications with private certificate stores may still require manual import.

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

On macOS, a validated `splitDNS` TUN profile captures only a dedicated Fake IP pool and the internal DNS address. The helper waits for the internal DNS to answer before registering a supplemental resolver for at least one validated capture domain (empty or invalid domain lists are rejected before starting the resolver). The same domain suffixes constrain Fake IP answers. A persistent `scutil` session owns a temporary Dynamic Store key; closing its stdin or losing the helper removes that key without overwriting another network service. No arbitrary resolver keys or shell commands are accepted over RPC. Split DNS process-lifecycle tests use a fixture process and do not alter host DNS.

The desktop Helper & Certificate Setup operation generates or reuses the local CA. On macOS, Authorization Services launches one elevated installer. After checksum-verified installation succeeds, the installed helper runs the desktop-only `trust-ca-privileged` CLI command with public DER supplied through stdin. That elevated process inserts the certificate and calls Security.framework directly, then verifies the admin trust record. It does not launch another desktop trust authorizer after installation. This follows kube-loop commit `79d2fa6b`. The command is not exposed through daemon RPC, rejects non-root callers, and is disabled in the rootless test helper. Helper installation failures skip CA changes; CA failures remain visible, without automatic fallback to a second authorization. An already installed helper can still service a certificate-only retry through the existing desktop trust flow. Existing trusted CAs are reused.

Tests verify sequencing, public-certificate transport, failure propagation and privilege guards without mutating system trust. They do not prove the number of native authorization dialogs. A clean first-install acceptance run on the target macOS must verify both the resulting certificate trust and the actual dialog count.

On Windows, scoped TUN uses native Win32 APIs throughout DNS/routing discovery and resolver ownership. The helper reads adapters with GetAdaptersAddresses, routes with GetIpForwardTable2/GetBestInterfaceEx, and processes with Toolhelp32. It writes per-domain NRPT rules through the registry API using the documented MS-GPNRPT layout; no PowerShell or netsh is used in this runtime path. Group Policy NRPT entries block local-rule activation, and overlapping local DNS policies are preserved and rejected. A protected, elevated native helper child owns a stdin lease outside the core job object. EOF removes only its own rules, while volatile registry keys disappear at reboot. Service startup recovers stale Fluxy rules, and Stop verifies restoration before releasing the core. Windows resolver lookups verify activation before reporting readiness.

Tests exercise real registry APIs under isolated HKCU test keys, without changing system DNS. They cover domain scope, conflicting policies, normal EOF cleanup, failed activation rollback and cleanup retries. Native UAC, actual NRPT activation, Wintun routing, traffic capture and reboot recovery still require Windows desktop acceptance.

### Windows system proxy

The desktop backend also uses the bundled native executable, launched as the current user (no service installation or UAC). `system-proxy` reads/writes WinINet LAN per-connection options through InternetQueryOptionW/InternetSetOptionW and sends settings-change notifications. It preserves PAC URLs, bypass lists, saved auto-detect flags, and non-HTTP protocol mappings. Proxy backup ownership checks also preserve unrelated edits on restoration. No PowerShell, cmd, netsh, or dynamically compiled C# is involved.

The crash watchdog receives the bundled executable's absolute path from the main process, so it can restore proxy settings in Electron's Node mode without accessing Electron's app API. Native ABI/input tests and simulated ownership tests run by default. The real Windows system-proxy test is opt-in: set `FLUXY_TEST_NATIVE_PROXY=1` and run `npx playwright test tests/e2e/windows-native-proxy.spec.ts --workers 1`. It temporarily changes the current user's proxy, captures an HTTP request using system configuration, verifies normal Stop restoration, terminates the actual Electron main PID, and verifies watchdog restoration.
