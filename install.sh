#!/usr/bin/env bash
# Download and install a published Fluxy release (macOS / Linux).
set -euo pipefail
version=latest
arch=auto
format=auto
dry_run=0
usage() {
    cat <<'HELP'
Usage: bash install.sh [--version VERSION] [--arch x64|arm64] [--format deb|rpm] [--dry-run]
Downloads Fluxy from github.com/fqix/fluxy and verifies its SHA-256 checksum.
macOS: installs to ~/Applications/Fluxy.app. Linux: uses apt-get, dnf, yum or zypper.
--version accepts latest (default), 0.1.0, or v0.1.0.
--dry-run prints the selected release URLs without downloading or installing.
HELP
}
fail() { printf 'Fluxy: %s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
    case "$1" in
        --version|--arch|--format)
            [ "$#" -ge 2 ] || fail "Missing value for $1"
            case "$1" in --version) version=$2;; --arch) arch=$2;; --format) format=$2;; esac
            shift 2;;
        --dry-run) dry_run=1; shift;;
        -h|--help) usage; exit 0;;
        *) fail "Unknown option: $1";;
    esac
 done
case "$(uname -s)" in Darwin) platform=mac;; Linux) platform=linux;; *) fail 'Use install.ps1 on Windows.';; esac
if [ "$arch" = auto ]; then
    case "$(uname -m)" in x86_64|amd64) arch=x64;; arm64|aarch64) arch=arm64;; *) fail 'Only x64 and arm64 are supported.';; esac
    if [ "$platform" = mac ] && [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then arch=arm64; fi
fi
case "$arch" in x64|arm64) ;; *) fail 'Architecture must be x64 or arm64.';; esac
manager=''
if [ "$platform" = mac ]; then
    [ "$format" = auto ] || fail '--format is only available on Linux.'
    format=dmg
else
    if [ "$format" = auto ]; then
        if command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then format=deb
        elif command -v rpm >/dev/null 2>&1; then format=rpm
        else fail 'No supported package manager found (deb/rpm only).'; fi
    fi
    case "$format" in
        deb) command -v apt-get >/dev/null 2>&1 || fail 'deb installation requires apt-get.'; manager=apt-get;;
        rpm)
            for candidate in dnf yum zypper; do
                if command -v "$candidate" >/dev/null 2>&1; then manager=$candidate; break; fi
            done
            [ -n "$manager" ] || fail 'rpm installation requires dnf, yum or zypper.';;
        *) fail 'Linux package format must be deb or rpm.';;
    esac
fi
version=${version#v}
if [ "$version" = latest ]; then
    tag="electron-stable-$arch"
    artifact="Fluxy-$platform-$arch.$format"
else
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || fail 'Invalid release version.'
    tag="v$version"
    package_arch=$arch
    case "$format:$arch" in deb:x64) package_arch=amd64;; rpm:x64) package_arch=x86_64;; rpm:arm64) package_arch=aarch64;; esac
    artifact="Fluxy-$version-$platform-$package_arch.$format"
fi
url="https://github.com/fqix/fluxy/releases/download/$tag/$artifact"
printf 'Fluxy: %s / %s / %s\n%s\n%s.sha256\n' "$platform" "$arch" "$format" "$url" "$url"
[ "$dry_run" = 0 ] || exit 0
command -v curl >/dev/null 2>&1 || fail 'curl is required.'
[ "$(id -u)" != 0 ] || fail 'Run as your desktop user; Linux installation will request sudo when needed.'
work=$(mktemp -d "${TMPDIR:-/tmp}/fluxy-install.XXXXXX")
mount=''
app_stage=''
backup=''
cleanup() {
    if [ -n "$mount" ]; then /usr/bin/hdiutil detach "$mount" -quiet >/dev/null 2>&1 || true; fi
    if [ -n "$backup" ] && [ -e "$backup" ] && [ ! -e "$HOME/Applications/Fluxy.app" ]; then mv "$backup" "$HOME/Applications/Fluxy.app"; fi
    [ -z "$app_stage" ] || rm -rf "$app_stage"
    rm -rf "$work"
}
trap cleanup EXIT
fetch() {
    curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 --connect-timeout 15 --max-time 900 --output "$2" "$1" ||
        fail "Download failed. The release may not contain this platform/architecture yet: $1"
}
fetch "$url.sha256" "$work/checksum"
expected=$(awk 'NR == 1 {print $1}' "$work/checksum")
[[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || fail 'Invalid SHA-256 checksum file.'
fetch "$url" "$work/$artifact"
if [ "$platform" = mac ]; then actual=$(/usr/bin/shasum -a 256 "$work/$artifact" | awk '{print $1}')
else actual=$(sha256sum "$work/$artifact" | awk '{print $1}'); fi
[ "$actual" = "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" ] || fail 'Checksum mismatch; nothing was installed.'
if [ "$platform" = mac ]; then
    if /usr/bin/pgrep -x Fluxy >/dev/null; then fail 'Quit Fluxy before updating it.'; fi
    mkdir -p "$work/mount" "$HOME/Applications"
    mount="$work/mount"
    /usr/bin/hdiutil attach "$work/$artifact" -readonly -nobrowse -mountpoint "$mount" -quiet
    bundle="$mount/Fluxy.app"
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$bundle/Contents/Info.plist")" = dev.fengqi.fluxy.electron ] || fail 'Unexpected application identity.'
    /usr/bin/codesign --verify --deep --strict "$bundle"
    if ! /usr/sbin/spctl --assess --type execute "$bundle"; then
        /usr/bin/codesign -dv --verbose=2 "$bundle" 2>&1 | /usr/bin/grep -q '^Signature=adhoc$' ||
            fail 'Gatekeeper rejected the signed application.'
        printf '%s\n' 'Fluxy: This release is not Apple-notarized. If macOS blocks the first launch, use System Settings > Privacy & Security > Open Anyway.' >&2
    fi
    destination="$HOME/Applications/Fluxy.app"
    if [ -e "$destination" ]; then
        [ ! -L "$destination" ] || fail 'Refusing to replace a symlink.'
        [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$destination/Contents/Info.plist")" = dev.fengqi.fluxy.electron ] || fail 'An unrelated Fluxy.app already exists.'
    fi
    app_stage=$(mktemp -d "$HOME/Applications/.fluxy-install.XXXXXX")
    /usr/bin/ditto "$bundle" "$app_stage/Fluxy.app"
    if [ -e "$destination" ]; then backup="$app_stage/previous.app"; mv "$destination" "$backup"; fi
    mv "$app_stage/Fluxy.app" "$destination"
    printf 'Installed %s\nOpen Fluxy from Applications.\n' "$destination"
else
    command -v sudo >/dev/null 2>&1 || fail 'sudo is required for package installation.'
    # Copy into root-owned staging and recheck after elevation, before executing package hooks.
    sudo /bin/bash -c '
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
root=$(mktemp -d /var/tmp/fluxy-install.XXXXXX)
trap '\''rm -rf "$root"'\'' EXIT
chmod 755 "$root"
install -m 644 "$1" "$root/fluxy.$3"
actual=$(sha256sum "$root/fluxy.$3" | cut -d " " -f 1)
[ "$actual" = "$2" ] || { echo "Checksum changed before installation" >&2; exit 1; }
case "$4" in
 apt-get) apt-get install -y "$root/fluxy.deb";;
 dnf|yum) "$4" install -y "$root/fluxy.rpm";;
 zypper) zypper --non-interactive install "$root/fluxy.rpm";;
 *) exit 1;;
esac
' fluxy-install "$work/$artifact" "$actual" "$format" "$manager"
    printf 'Fluxy installed. Open it from your application menu.\n'
fi
