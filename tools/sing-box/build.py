#!/usr/bin/env python3
"""Build Fluxy's pinned, reduced sing-box transport core for Electron."""
import argparse
import hashlib
from contextlib import contextmanager
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SOURCE = ROOT / 'third_party/sing-box'
PIN = json.loads((HERE / 'pin.json').read_text())
ARCHES = {'arm64': 'arm64', 'x86_64': 'amd64'}
TARGET = platform.system().lower().replace('windows', 'windows')

@contextmanager
def build_lock(path):
    with path.open('a+b') as lock:
        if os.name == 'nt':
            import msvcrt
            lock.write(b'0'); lock.flush(); lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == 'nt':
                lock.seek(0); msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def run(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def output(args, **kwargs):
    return run(args, capture_output=True, text=True, **kwargs).stdout.strip()


def go_binary():
    candidate = os.environ.get('FLUXY_GO') or shutil.which('go')
    if not candidate:
        candidate = next((p for p in ['/opt/homebrew/bin/go', '/usr/local/go/bin/go', '/usr/local/bin/go']
                          if Path(p).is_file()), None)
    if not candidate:
        raise RuntimeError('Go is required. Install Go, or set FLUXY_GO to its executable path.')
    return candidate


def validate_source():
    if not (SOURCE / 'go.mod').is_file():
        raise RuntimeError('Initialize the pinned source first: git submodule update --init third_party/sing-box')
    revision = output(['git', '-C', SOURCE, 'rev-parse', 'HEAD'])
    if revision != PIN['revision']:
        raise RuntimeError(f'sing-box revision mismatch: expected {PIN["revision"]}, got {revision}')
    if output(['git', '-C', SOURCE, 'status', '--porcelain', '--untracked-files=all']):
        raise RuntimeError('sing-box submodule has local changes; the embedded core must use the clean pinned source.')


def go_env(arch):
    env = dict(os.environ)
    env.update(GOTOOLCHAIN=PIN['toolchain'], GOWORK='off', GOENV='off', GOFLAGS='',
               GOOS=TARGET, GOARCH=ARCHES[arch], CGO_ENABLED='0')
    return env


def packages(go, env):
    data = output([go, 'list', '-mod=readonly', '-tags=' + ','.join(PIN['tags']), '-deps', '-json', '.'],
                  cwd=HERE, env=env)
    decoder = json.JSONDecoder()
    index = 0
    while index < len(data):
        while index < len(data) and data[index].isspace():
            index += 1
        if index == len(data):
            break
        package, index = decoder.raw_decode(data, index)
        yield package


def collect_notices(go, env):
    modules = {}
    notices = {}
    goroot = Path(output([go, 'env', 'GOROOT'], env=env)).resolve()
    compiled_packages = list(packages(go, env))
    imports = {package['ImportPath'] for package in compiled_packages}
    excluded = ('protocol/vmess', 'protocol/vless', 'protocol/shadowsocks', 'protocol/trojan',
                'protocol/hysteria', 'protocol/tuic', 'protocol/wireguard', 'protocol/tailscale',
                'protocol/ssh', 'protocol/anytls', 'experimental/clashapi', 'experimental/v2rayapi', 'include')
    for name in imports:
        if any(name == 'github.com/sagernet/sing-box/' + prefix or
               name.startswith('github.com/sagernet/sing-box/' + prefix + '/') for prefix in excluded):
            raise RuntimeError('Excluded package entered the core dependency graph: ' + name)
    if not any(name.startswith('github.com/sagernet/gvisor/') for name in imports):
        raise RuntimeError('gVisor TUN stack is missing from the dependency graph')
    for package in compiled_packages:
        module = package.get('Module')
        if not module:
            module = {'Path': 'Go', 'Dir': str(goroot)}
        actual = module.get('Replace', module)
        directory = Path(actual['Dir']).resolve()
        modules[module['Path']] = module.get('Version', 'local')
        package_dir = Path(package['Dir']).resolve()
        for folder in [package_dir, *package_dir.parents]:
            if not folder.is_relative_to(directory):
                break
            for entry in folder.iterdir():
                if entry.is_file() and entry.name.upper().startswith(('LICENSE', 'COPYING', 'NOTICE', 'COPYRIGHT', 'PATENTS')):
                    key = module['Path'] + '/' + str(entry.relative_to(directory))
                    notices[key] = entry.read_text(errors='replace')
            if folder == directory:
                license_dir = folder / 'LICENSES'
                if license_dir.is_dir():
                    for entry in license_dir.rglob('*'):
                        if entry.is_file():
                            notices[module['Path'] + '/' + str(entry.relative_to(directory))] = entry.read_text(errors='replace')
                break
    license_path = goroot / 'LICENSE'
    if not license_path.is_file():
        license_path = goroot.parent / 'LICENSE'  # Homebrew keeps it beside libexec.
    notices['Go/LICENSE'] = license_path.read_text()
    text = 'Fluxy transport core: sing-box ' + PIN['version'] + '\n'
    text += 'Source: https://github.com/SagerNet/sing-box/tree/' + PIN['revision'] + '\n'
    text += 'Build profile and wrapper source: tools/sing-box in the Fluxy source repository.\n\n'
    for name, contents in sorted(notices.items()):
        text += f'===== {name} =====\n{contents}\n\n'
    return text, modules


def build(destination, arches, work, go):
    work.mkdir(parents=True, exist_ok=True)
    fingerprint = hashlib.sha256()
    for path in sorted(HERE.glob('*')):
        if path.is_file() and path.suffix in {'.go', '.mod', '.sum', '.json', '.py'}:
            fingerprint.update(path.name.encode())
            fingerprint.update(path.read_bytes())
    fingerprint.update((TARGET + ' ' + ' '.join(arches)).encode())
    key = fingerprint.hexdigest()
    cached = work / key
    core = cached / 'fluxy-core'
    manifest = cached / 'manifest.json'
    if not core.is_file() or not manifest.is_file() or not (cached / 'licenses.txt').is_file():
        cached.mkdir(parents=True, exist_ok=True)
        slices = []
        for arch in arches:
            binary = cached / ('fluxy-core-' + arch)
            flags = '-s -w -buildid= -X github.com/sagernet/sing-box/constant.Version=' + PIN['version']
            flags += ' -X main.revision=' + PIN['revision']
            print('Building Fluxy core ' + PIN['version'] + ' for ' + arch, flush=True)
            run([go, 'build', '-mod=readonly', '-trimpath', '-buildvcs=false',
                 '-tags=' + ','.join(PIN['tags']), '-ldflags=' + flags, '-o', binary, '.'],
                cwd=HERE, env=go_env(arch))
            slices.append(binary)
        if len(slices) == 1:
            shutil.copyfile(slices[0], core)
        else:
            run(['xcrun', 'lipo', '-create', *slices, '-output', core])
        notices, modules = collect_notices(go, go_env(arches[0]))
        (cached / 'licenses.txt').write_text(notices)
        manifest.write_text(json.dumps({**PIN, 'platform': TARGET, 'architectures': arches, 'profile': 'fluxy-transport',
                                       'modules': modules, 'unsignedSHA256': hashlib.sha256(core.read_bytes()).hexdigest()}, indent=2) + '\n')
    else:
        print('Using cached Fluxy core ' + PIN['version'] + ' (' + ', '.join(arches) + ')', flush=True)
    expected_hash = json.loads(manifest.read_text())['unsignedSHA256']
    if hashlib.sha256(core.read_bytes()).hexdigest() != expected_hash:
        raise RuntimeError('Cached core checksum mismatch; remove its build cache directory and rebuild.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(core, destination)
    destination.chmod(0o755)
    return cached


def main():
    global TARGET
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', choices=['darwin', 'linux', 'windows'], default=TARGET)
    parser.add_argument('--arch', action='append', choices=ARCHES)
    parser.add_argument('--output', type=Path, default=ROOT / 'build/fluxy-core')
    args = parser.parse_args()
    TARGET = args.platform
    validate_source()
    go = go_binary()
    arches = args.arch or [{'AMD64':'x86_64','aarch64':'arm64'}.get(platform.machine(), platform.machine())]
    arches = sorted(set(arches))
    if not arches or any(arch not in ARCHES for arch in arches):
        raise RuntimeError('Unsupported architecture selection: ' + repr(arches))
    if len(arches) > 1 and (TARGET != 'darwin' or platform.system() != 'Darwin'):
        raise RuntimeError('Universal builds require a macOS host and target')
    destination = args.output.resolve()
    work = ROOT / 'build/fluxy-core-cache'
    work.mkdir(parents=True, exist_ok=True)
    with build_lock(work / '.build.lock'):
        cached = build(destination, arches, work, go)
    shutil.copyfile(cached / 'licenses.txt', Path(str(destination) + '.licenses.txt'))
    shutil.copyfile(cached / 'manifest.json', Path(str(destination) + '.build.json'))
    print('Fluxy core ready: ' + str(destination), flush=True)


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, KeyError, subprocess.SubprocessError) as error:
        print('error: ' + str(error), file=sys.stderr)
        sys.exit(1)
