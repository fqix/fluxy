# Privileged helper platforms

Fluxy uses the same authenticated, newline-delimited JSON RPC protocol on all three desktop platforms.

| Platform | Implementation | Installation | Local transport |
| --- | --- | --- | --- |
| macOS 13+ | `internal/platform/platform_darwin.go` | launchd, administrator authorization | Unix socket and Security.framework audit-token caller verification |
| Linux with systemd | `internal/platform/platform_linux.go` | systemd, `pkexec` | Unix socket, paired UID and executable hash |
| Windows 10/11 | `internal/platform/platform_windows.go` | Windows service, UAC | Named pipe, paired SID and executable hash |

The Go helper accepts only status, typed TUN start/ready/stop, and install/remove of a self-signed Fluxy root CA. It generates its own core configuration. It never accepts executable paths, shell commands, or arbitrary configuration files over RPC. Installation verifies staged binary and pairing checksums after copying into an administrator-owned directory. The application keeps a random pairing token in its private data directory.

TUN capture uses one helper-owned sing-box process containing the TUN inbound,
the public mixed inbound, authenticated direct-egress ingress, and the embedded
`fluxy-inspector` service. There is no second inspection process or HTTP inspection
bridge. `tun.start` accepts an `inspector` listener description and returns a
loopback control port. Electron authenticates to this one-use relay with the
session's random token; the helper forwards the stream to the core's stdin/stdout.
Unauthenticated connections cannot send inspection commands. Closing the control
stream closes core stdin. After the inspector's ready frame, `tun.ready` waits for
inbounds and installs scoped DNS before capture becomes running.

One connection owns the TUN session. Disconnect or 20 seconds without a request stops its core. Core stdin EOF requests graceful shutdown, including when the helper crashes; Windows additionally uses a job object. Normal service stop also waits for the core to close. Application updates that change the paired executable require Helper repair.

Linux requires systemd, polkit (`pkexec` and a desktop authentication agent), `iproute2`, `/dev/net/tun`, `openssl`, and the distribution's `ca-certificates` package. Automatic CA installation supports Debian/Ubuntu's `update-ca-certificates` and Fedora/RHEL's `update-ca-trust`. Other trust-store layouts need manual certificate import. Windows uses the LocalMachine Root store through Crypt32. Windows Helper setup, repair, removal, SID lookup, certificate writes, and certificate status checks do not invoke PowerShell, cmd, or scripts. The bundled helper calls ShellExecuteExW for UAC and Service Control Manager APIs for service lifecycle. Setup accepts a typed action and pinned hashes, creates the protected staging directory with a native security descriptor, and reports errors over a private named pipe. Existing files are retained for rollback until service startup succeeds. UAC consent is still required. The pinned sing-tun dependency embeds its architecture-specific Wintun driver; no runtime download is needed. Applications with private certificate stores may still require manual import.

## Package layout

`main.go` only dispatches the command line. Every capability lives in a package under `internal/`, so a platform file contains one concern instead of the whole helper.

| Package | Responsibility |
| --- | --- |
| `internal/protocol` | Service identity, build mode, strict JSON decoding, TUN interface naming, pairing record and caller verification |
| `internal/platform` | launchd/systemd/service adaptation: environment, installation directory, listener, peer verification, child containment |
| `internal/daemon` | The RPC loop and the service entry point |
| `internal/tun` | TUN request validation, generated core configuration and the single core session |
| `internal/splitdns` | Scoped Fake IP DNS profile and the per-platform resolver owner (`scutil` on macOS, NRPT on Windows) |
| `internal/certs` | Fluxy root CA parsing and every trust-store change |
| `internal/setup` | Elevated installation: Authorization Services on macOS, UAC on Windows |
| `internal/winnet` | Typed native Windows queries: system proxy, trust status, adapters, routes, processes |
| `internal/coreio` | Bounded, credential-redacted core output |

Platform-specific files keep the `_darwin`/`_linux`/`_windows` suffix, so a cross-compile selects them without build tags. Files that implement a rejecting stub for the remaining platforms carry an explicit `//go:build` constraint.

## Build and verify

From the repository root, `npm run core:build` builds the native host target. `FLUXY_BUILD_PLATFORM=linux|win32|darwin` and `FLUXY_BUILD_ARCH=x64|arm64` select another target. All helpers are built with Go. macOS uses cgo to call Security.framework for audit-token/signature verification and exact system keychain access; it requires macOS and Xcode Command Line Tools, but no Swift compiler. Linux and Windows use CGO_ENABLED=0. Windows build output names include `.exe`; package resources and integrity manifests use the same names. Go is needed for the transport core on every build host. `FLUXY_GO` overrides executable discovery.

```sh
cd helper
go test -race ./...
go vet ./...
GOOS=linux GOARCH=amd64 go build -o /tmp/fluxy-helper-linux .
GOOS=windows GOARCH=amd64 go build -o /tmp/fluxy-helper.exe .
```

Tests use temporary sockets/pipes, generated certificates, and a harmless child-process fixture. They do not install services, change system trust, or create TUN interfaces. CI runs the test/build/package matrix on macOS, Linux and Windows. Successful cross-compilation alone does not validate UAC/polkit prompts, service ACLs, live TUN routing, or restoration on those operating systems; these require native desktop acceptance testing.

On macOS, a validated `splitDNS` TUN profile captures only a dedicated Fake IP pool and the internal DNS address. The helper waits for the internal DNS to answer before registering a supplemental resolver for at least one validated capture domain (empty or invalid domain lists are rejected before starting the resolver). The same domain suffixes constrain Fake IP answers. A persistent `scutil` session owns a temporary Dynamic Store key; closing its stdin or losing the helper removes that key without overwriting another network service. No arbitrary resolver keys or shell commands are accepted over RPC. Split DNS process-lifecycle tests use a fixture process and do not alter host DNS.

Welcome presents Helper installation and CA installation as separate steps.
`helper:install` only installs or updates the helper; it does not create or trust a
certificate. On macOS, `certificate:trust` generates or reuses the local CA and
installs it into the user trust domain, which needs no elevation and no helper at
all: the Helper service may be missing, stopped, outdated, or unavailable, and
pairing and the sing-box binary are not required. Existing trusted CAs are reused,
and CA cancellation can be retried independently of Helper setup. TUN capture is
enabled only after both steps are ready, because TUN itself needs the helper.

Tests verify sequencing, public-certificate transport, failure propagation and privilege guards without mutating system trust. They do not prove the number of native authorization dialogs. A clean first-install acceptance run on the target macOS must verify both the resulting certificate trust and the actual dialog count.

On Windows, scoped TUN uses native Win32 APIs throughout DNS/routing discovery and resolver ownership. The helper reads adapters with GetAdaptersAddresses, routes with GetIpForwardTable2/GetBestInterfaceEx, and processes with Toolhelp32. It writes per-domain NRPT rules through the registry API using the documented MS-GPNRPT layout; no PowerShell or netsh is used in this runtime path. Group Policy NRPT entries block local-rule activation, and overlapping local DNS policies are preserved and rejected. A protected, elevated native helper child owns a stdin lease outside the core job object. EOF removes only its own rules, while volatile registry keys disappear at reboot. Service startup recovers stale Fluxy rules, and Stop verifies restoration before releasing the core. Windows resolver lookups verify activation before reporting readiness.

Tests exercise real registry APIs under isolated HKCU test keys, without changing system DNS. They cover domain scope, conflicting policies, normal EOF cleanup, failed activation rollback and cleanup retries. Native UAC, actual NRPT activation, Wintun routing, traffic capture and reboot recovery still require Windows desktop acceptance.

### Windows system proxy

The desktop backend also uses the bundled native executable, launched as the current user (no service installation or UAC). `system-proxy` reads/writes WinINet LAN per-connection options through InternetQueryOptionW/InternetSetOptionW and sends settings-change notifications. It preserves PAC URLs, bypass lists, saved auto-detect flags, and non-HTTP protocol mappings. Proxy backup ownership checks also preserve unrelated edits on restoration. No PowerShell, cmd, netsh, or dynamically compiled C# is involved.

The crash watchdog receives the bundled executable's absolute path from the main process, so it can restore proxy settings in Electron's Node mode without accessing Electron's app API. Native ABI/input tests and simulated ownership tests run by default. The real Windows system-proxy test is opt-in: set `FLUXY_TEST_NATIVE_PROXY=1` and run `npx playwright test tests/e2e/windows-native-proxy.spec.ts --workers 1`. It temporarily changes the current user's proxy, captures an HTTP request using system configuration, verifies normal Stop restoration, terminates the actual Electron main PID, and verifies watchdog restoration.

### macOS certificate installation and removal

Installation and removal run the verified bundled native executable in the
logged-in desktop session, unelevated and without daemon RPC: `trust-ca-desktop`
adds the CA to the login keychain and writes `kSecTrustSettingsDomainUser` trust
settings, and `untrust-ca-desktop` removes both, matching the keychain's own item
by exact DER because a certificate rebuilt from DER is not a keychain item.
A canceled or failed trust dialog deletes the copy the same run inserted, so
cancelling leaves nothing behind. macOS presents exactly one dialog, from
Security.framework, asking for the session owner's own password.
Trust therefore covers the logged-in user — Safari, Chrome, `curl`, Node — but not
other accounts or system daemons.

This replaces the earlier admin-domain flow, which could not reach one dialog.
`com.apple.trust-settings.admin` is satisfied by `entitled` (Apple-private) or
`authenticate-admin`, and `authenticate-admin` carries `allow-root false` with
`timeout 0`: root does not satisfy it and its credential cannot be cached or
pre-authorized. That is why the two earlier attempts failed — preauthorizing both
rights still produced two dialogs, and desktop-side admin trust returned OSStatus
-61 because the System keychain needs root. `com.apple.trust-settings.user` is
`entitled-session-owner-or-authenticate-session-owner` instead, so the session
owner grants it directly. System authorization rules and SIP settings remain
unchanged.

`trust-ca-privileged` and `remove-ca-privileged` remain for the admin domain.
Machines set up before this change still carry an admin-domain record that only
root can clear, so certificate removal runs the unelevated removal first and falls
back to the elevated uninstaller only while the CA still verifies as trusted.
Expired self-signed Fluxy roots remain removable. Rootless test helpers disable
certificate mutations; tests simulate authorization without altering system trust.

The macOS **Helper uninstall** action stops capture and removes only the helper service.
Certificates and system/browser trust are preserved. **Certificate → Uninstall Certificate…**
removes CA trust separately, even after Helper has been uninstalled. It runs the
integrity-checked bundled helper's `untrust-ca-desktop` in the desktop session. Only
when the CA still verifies as trusted afterwards — an admin-domain record from a
release before the user trust domain — does it fall back to an elevated shell that
copies the bundled helper into a root-owned temporary directory, checks its SHA-256
and invokes `remove-ca-privileged`. Browser trust cleanup follows successful system
removal. Saved traffic, custom CA trust and the local CA identity remain unchanged.
Tests verify one application authorization request and failure ordering; actual
macOS authorization dialog counts require a native interactive acceptance run.
