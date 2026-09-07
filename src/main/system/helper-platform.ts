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
export const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`
export const encodedPowerShell = (script: string) =>
    Buffer.from(script, 'utf16le').toString('base64')
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
    } else if (platform === 'win32') {
        const encoded = encodedPowerShell(script)
        await execute('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            encodedPowerShell(
                `$ErrorActionPreference='Stop'; $p=Start-Process -FilePath "$PSHOME\\powershell.exe" -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${encoded}'; if ($p.ExitCode -ne 0) { throw 'Helper authorization or installation failed' }`
            )
        ])
    } else throw new Error('Unsupported helper platform')
}
export async function currentSID() {
    const { stdout } = await promisify(execFile)(
        'powershell.exe',
        [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'
        ],
        { timeout: 5000, windowsHide: true }
    )
    const sid = stdout.trim()
    if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) throw new Error('Cannot resolve the desktop user SID')
    return sid
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
    if (platform !== 'win32') throw new Error('Unsupported helper platform')
    return `$ErrorActionPreference='Stop'
$base=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'FluxyHelper'
$stage=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) ('FluxyInstall-'+[Guid]::NewGuid().ToString('N'))
function Protect($path) {
 $acl=New-Object System.Security.AccessControl.DirectorySecurity
 $acl.SetAccessRuleProtection($true,$false)
 foreach ($sid in @('S-1-5-18','S-1-5-32-544')) {
  $identity=New-Object System.Security.Principal.SecurityIdentifier($sid)
  $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
 }
 Set-Acl -LiteralPath $path -AclObject $acl
}
New-Item -ItemType Directory -Path $stage | Out-Null
Protect $stage
try {
${[
    ['fluxy-helper', hashes.helperSHA256],
    ['fluxy-core', hashes.coreSHA256],
    ['pairing.json', pairingHash]
]
    .map(
        ([
            name,
            hash
        ]) => `Copy-Item -LiteralPath ${psQuote(join(stage, name))} -Destination (Join-Path $stage '${name.endsWith('.json') ? name : name + '.exe'}')
 if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $stage '${name.endsWith('.json') ? name : name + '.exe'}')).Hash -ne '${hash}') { throw 'Helper integrity check failed' }`
    )
    .join('\n')}
 $service=Get-Service -Name '${id}' -ErrorAction SilentlyContinue
 if ($service) {
  $serviceInfo=Get-CimInstance Win32_Service -Filter "Name='${id}'"
  $worker=if ($serviceInfo.ProcessId) { Get-Process -Id $serviceInfo.ProcessId -ErrorAction SilentlyContinue } else { $null }
  Stop-Service -Name '${id}'
  $service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))
  if ($worker -and !$worker.WaitForExit(30000)) { throw 'Helper process is still stopping' }
 }
 if (Test-Path -LiteralPath $base) {
  if ((Get-Item -LiteralPath $base).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe helper directory' }
  Remove-Item -LiteralPath $base -Recurse -Force
 }
 Move-Item -LiteralPath $stage -Destination $base
 $binary='"'+(Join-Path $base 'fluxy-helper.exe')+'"'
 if ($service) {
  $instance=Get-CimInstance Win32_Service -Filter "Name='${id}'"
  $result=Invoke-CimMethod -InputObject $instance -MethodName Change -Arguments @{PathName=$binary;StartMode='Automatic'}
  if ($result.ReturnValue -ne 0) { throw 'Cannot update helper service' }
 }
 else { New-Service -Name '${id}' -BinaryPathName $binary -DisplayName 'Fluxy Helper' -StartupType Automatic | Out-Null }
 Start-Service -Name '${id}'
} finally { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force } }`
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
    if (platform !== 'win32') throw new Error('Unsupported helper platform')
    return `$ErrorActionPreference='Stop'
$service=Get-Service -Name '${id}' -ErrorAction SilentlyContinue
if ($service) {
 $serviceInfo=Get-CimInstance Win32_Service -Filter "Name='${id}'"
 $worker=if ($serviceInfo.ProcessId) { Get-Process -Id $serviceInfo.ProcessId -ErrorAction SilentlyContinue } else { $null }
 Stop-Service -Name '${id}'
 $service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))
 if ($worker -and !$worker.WaitForExit(30000)) { throw 'Helper process is still stopping' }
 $instance=Get-CimInstance Win32_Service -Filter "Name='${id}'"
 $result=Invoke-CimMethod -InputObject $instance -MethodName Delete
 $service.Dispose()
 if ($result.ReturnValue -ne 0) { throw 'Cannot remove helper service' }
}
$base=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'FluxyHelper'
if (Test-Path -LiteralPath $base) {
 if ((Get-Item -LiteralPath $base).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe helper directory' }
 Remove-Item -LiteralPath $base -Recurse -Force
}`
}
