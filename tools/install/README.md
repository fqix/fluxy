# Install a published Fluxy release

The repository's `install.sh` and `install.ps1` download release packages, check SHA-256, and install the application. They do not build source or install the privileged Helper service. Install Helper and trust the CA through Fluxy's setup screen when needed.

## macOS and Linux

```sh
curl --fail --location https://raw.githubusercontent.com/fqix/fluxy/main/install.sh | bash
```

macOS installs the application to `~/Applications/Fluxy.app`. Existing Fluxy installations in that location are replaced; preferences are preserved. Quit Fluxy before updating. The script verifies the app identifier and code-signature integrity. Releases built without Apple credentials use ad-hoc signing and are not notarized. If Gatekeeper blocks the first launch, use **System Settings → Privacy & Security → Open Anyway**. The script reports the assessment result without changing Gatekeeper settings.

Linux supports **deb and rpm only**. Debian/Ubuntu use `apt-get`; Fedora/RHEL and compatible distributions use `dnf` or `yum`; openSUSE uses `zypper`. The script requests sudo for the package-manager step and rechecks a root-owned copy of the package before installation. System package managers resolve runtime dependencies. No AppImage is produced or installed.

With a local checkout, inspect or select the installation:

```sh
bash install.sh --dry-run
bash install.sh --version 0.1.0
bash install.sh --arch arm64 --format deb   # Linux only
```

## Windows

Run in PowerShell as your desktop user:

```powershell
irm https://raw.githubusercontent.com/fqix/fluxy/main/install.ps1 | iex
```

The script downloads the NSIS installer, validates SHA-256, and runs its silent installation mode. The installer installs per user. It reports failures and any restart requirement without initiating a restart itself.

The script writes each installation stage and any error to `%TEMP%\fluxy-install.log`. If the terminal closes unexpectedly, open this file after reopening PowerShell:

```powershell
Get-Content "$env:TEMP\fluxy-install.log"
```

Use `-LogPath` to choose another log file. The log contains installer diagnostics, not a transcript of your terminal session.

From a local checkout:

```powershell
.\install.ps1 -DryRun
.\install.ps1 -Version 0.1.0 -Arch x64
```

Both scripts detect x64 or arm64 and allow an explicit override. The requested platform and architecture must have release artifacts; there is no fallback to an incompatible build.

## Publishing contract

The release workflow builds macOS DMG/ZIP, Linux deb/rpm, and Windows NSIS packages. The release matrix covers macOS x64/arm64, Linux x64/arm64, and Windows x64/arm64. Each runner builds its native architecture, with explicit architecture selection for Node.js, the core, the Helper and Electron packaging. macOS Intel uses `macos-15-intel`; macOS Apple Silicon uses `macos-latest`. Linux ARM64 uses `ubuntu-24.04-arm`; Windows ARM64 uses `windows-11-arm`. The final publish job runs only when all platform builds succeed. macOS uses Developer ID signing and notarization when all five Apple signing secrets are configured, or ad-hoc signing without notarization when none are configured. Partial configuration fails the build; Windows accepts optional `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` signing secrets.

`tools/publish-electron-release.mjs --prepare` creates per-file SHA-256 sidecars and a release plan, and collects updater metadata without uploading anything. The aggregate `--publish release-artifacts` step uploads:

- Versioned assets under `vVERSION`, such as `Fluxy-0.1.0-linux-amd64.deb` and its `.sha256` sidecar.
- Architecture-specific updater metadata in the same release: `latest-x64.yml` / `latest-arm64.yml` on Windows, `latest-x64-mac.yml` / `latest-arm64-mac.yml` on macOS, and `latest-x64-linux.yml` / `latest-arm64-linux-arm64.yml` on Linux.
- The two installation scripts, `install.sh` and `install.ps1`.

Only `vVERSION` releases are created. Packaged clients use the generic update URL `https://github.com/fqix/fluxy/releases/latest/download/` with the `latest-ARCH` channel; electron-builder expands the architecture and both builder and updater append the platform suffix. Installation scripts resolve GitHub's latest release redirect, then download the versioned package and checksum from that exact release. Dry runs perform this metadata lookup but do not download packages or install anything; an explicit version skips the lookup.

Clients built before this change still point to the removed architecture feed releases. Those clients need one manual installation of a newer build that uses the new update URL.

The one-line commands become usable after these scripts are pushed to the repository and matching artifacts are publicly accessible. Missing assets, inaccessible/private releases and checksum mismatches cause an explicit failure rather than an attempted installation. A release upload in progress can briefly cause a checksum mismatch; rerun after publishing completes.

## Package size

React, React DOM and Lucide are build-time dependencies: Vite includes the required renderer code in the UI bundle, so their full npm packages are excluded from the installed application. Source maps are omitted from release packages. Electron language resources retain English (US/UK) and Chinese (Simplified/Traditional); the application interface is unchanged. The proxy core, native helper, certificates, protocol decoders and update components remain included. Renderer dependency license texts are copied into `licenses/` inside the app archive. macOS DMGs use UDBZ compression for smaller downloads.

## Verification

`npx vitest run tests/unit/install.test.ts` uses temporary fake downloads and a stubbed sudo command. It covers release metadata/checksums, deb/rpm selection, dry-run, invalid versions, and corrupt-download rejection. On Windows, run `powershell -NoProfile -File tools/install/test-windows.ps1`; it stubs downloading and process launching, so no installer executes. CI includes both suites.
