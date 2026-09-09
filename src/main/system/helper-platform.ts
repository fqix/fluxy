import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { shellQuote } from '../tun/tun-config'

const id = 'dev.fengqi.fluxy.electron.helper'
export const supportedHelperPlatform = (platform = process.platform) =>
    ['darwin', 'linux', 'win32'].includes(platform)
export const helperEndpoint = (platform = process.platform) =>
    platform === 'win32'
        ? `\\\\.\\pipe\\${id}`
        : platform === 'linux'
          ? `/run/${id}/helper.sock`
          : `/private/var/run/${id}.sock`
export const executableName = (name: string, platform = process.platform) =>
    name + (platform === 'win32' ? '.exe' : '')
export async function authorizePortable(script: string, platform = process.platform) {
    const execute = (file: string, args: string[]) =>
        new Promise<void>((resolve, reject) => {
            const child = spawn(file, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true
            })
            let output = ''
            const collect = (data: Buffer) => {
                output = (output + data.toString()).slice(-16384)
            }
            child.stdout.on('data', collect)
            child.stderr.on('data', collect)
            const timeout = setTimeout(() => {
                child.kill()
                reject(new Error('Helper authorization timed out'))
            }, 180000)
            child.once('error', (error) => {
                clearTimeout(timeout)
                reject(error)
            })
            child.once('close', (code) => {
                clearTimeout(timeout)
                code === 0
                    ? resolve()
                    : reject(new Error(output.trim() || 'Helper authorization canceled or failed'))
            })
        })
    if (platform === 'linux') {
        await execute('/usr/bin/pkexec', ['/bin/sh', '-c', script])
    } else throw new Error('Unsupported helper platform')
}
export async function currentSID(helperPath: string) {
    const { stdout } = await promisify(execFile)(helperPath, ['user-sid'], {
        timeout: 10000,
        windowsHide: true
    })
    const sid = JSON.parse(stdout)
    if (typeof sid !== 'string' || !/^S-1-\d+(?:-\d+)+$/.test(sid))
        throw new Error('Cannot resolve the desktop user SID')
    return sid
}
export function windowsInstallationRequest(stage: string, hashes: Hashes, pairingSHA256: string) {
    for (const hash of [hashes.helperSHA256, hashes.coreSHA256, pairingSHA256])
        if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid installation checksum')
    return JSON.stringify({
        action: 'install',
        stage,
        helperSHA256: hashes.helperSHA256,
        coreSHA256: hashes.coreSHA256,
        pairingSHA256
    })
}
export function authorizeWindowsSetup(helperPath: string, request: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(helperPath, ['setup-native'], {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        })
        let output = ''
        child.stderr.on('data', (data: Buffer) => {
            output = (output + data.toString()).slice(-16384)
        })
        child.stdout.resume()
        child.once('error', reject)
        child.once('close', (code) =>
            code === 0
                ? resolve()
                : reject(new Error(output.trim() || 'Native Helper setup failed'))
        )
        child.stdin.on('error', reject)
        child.stdin.end(request)
    })
}
type Hashes = { helperSHA256: string; coreSHA256: string }
export function portableInstallationScript(
    stage: string,
    hashes: Hashes,
    pairingHash: string,
    platform = process.platform
) {
    for (const value of [hashes.helperSHA256, hashes.coreSHA256, pairingHash])
        if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid installation checksum')
    if (platform === 'linux')
        return `set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
command -v systemctl >/dev/null
[ -d /run/systemd/system ] || { echo 'systemd is required for Helper Tool' >&2; exit 1; }
install -d -m 755 /usr/local/lib
[ ! -L /usr/local/lib/fluxy-helper ]
root=$(mktemp -d /usr/local/lib/fluxy-install.XXXXXX)
trap 'rm -rf "$root"' EXIT
${[
    ['fluxy-helper', hashes.helperSHA256],
    ['fluxy-core', hashes.coreSHA256],
    ['pairing.json', pairingHash]
]
    .map(
        ([
            name,
            hash
        ]) => `install -m ${name.endsWith('.json') ? '400' : '500'} ${shellQuote(join(stage, name))} "$root/${name}"
[ "$(sha256sum "$root/${name}" | cut -d ' ' -f 1)" = '${hash}' ]`
    )
    .join('\n')}
if systemctl cat ${id}.service >/dev/null 2>&1; then
 systemctl stop ${id}.service
 [ "$(systemctl show -p MainPID --value ${id}.service)" = 0 ]
fi
install -d -m 700 -o root -g root /usr/local/lib/fluxy-helper
mv -f "$root/fluxy-helper" "$root/fluxy-core" "$root/pairing.json" /usr/local/lib/fluxy-helper/
cat > /etc/systemd/system/${id}.service <<'FLUXY_SERVICE'
[Unit]
Description=Fluxy privileged network helper
After=network.target
[Service]
Type=simple
ExecStart=/usr/local/lib/fluxy-helper/fluxy-helper
RuntimeDirectory=${id}
RuntimeDirectoryMode=0755
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
KillMode=mixed
UMask=0077
[Install]
WantedBy=multi-user.target
FLUXY_SERVICE
chmod 644 /etc/systemd/system/${id}.service
systemctl daemon-reload
systemctl enable --now ${id}.service`
    throw new Error('Script setup is only supported on Linux')
}
export function portableUninstallationScript(platform = process.platform) {
    if (platform === 'linux')
        return `set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
if systemctl cat ${id}.service >/dev/null 2>&1; then
 systemctl stop ${id}.service
 [ "$(systemctl show -p MainPID --value ${id}.service)" = 0 ]
fi
systemctl disable ${id}.service 2>/dev/null || true
rm -f /etc/systemd/system/${id}.service
systemctl daemon-reload
rm -rf /usr/local/lib/fluxy-helper /run/${id}`
    throw new Error('Script setup is only supported on Linux')
}
