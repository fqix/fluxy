import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import type { HelperStatus } from '../../shared/contracts/model'
import { shellQuote } from '../tun/tun-config'
import {
    supportedHelperPlatform,
    helperEndpoint,
    authorizePortable,
    authorizeWindowsSetup,
    windowsInstallationRequest,
    currentSID,
    portableInstallationScript,
    portableUninstallationScript
} from './helper-platform'

export const helperID = 'dev.fengqi.fluxy.electron.helper'
export const helperSocket = helperEndpoint()
interface Reply {
    buildID: string
    controlPort?: number
    tunRunning: boolean
    tunError?: string
}
interface Manifest {
    version: number
    buildID: string
    helperSHA256: string
    coreSHA256: string
}
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex')

// A single leased connection owns TUN. Closing it (including app crashes) causes
// the daemon to stop the core. An unresponsive app loses its lease after 20s.
export class HelperRPC {
    private socket?: net.Socket
    private connecting?: Promise<void>
    private sequence = 0
    private pending = new Map<
        number,
        { resolve: (value: Reply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
    >()
    constructor(
        private path: string,
        private token: string,
        private disconnected: (error: Error) => void = () => {}
    ) {}
    private connect(): Promise<void> {
        if (this.connecting) return this.connecting
        if (this.socket && !this.socket.destroyed) return Promise.resolve()
        this.connecting = new Promise<void>((resolve, reject) => {
            const socket = net.createConnection(this.path)
            this.socket = socket
            let buffer = ''
            const timeout = setTimeout(
                () => socket.destroy(new Error('Helper connection timed out')),
                3000
            )
            socket.once('connect', () => {
                clearTimeout(timeout)
                resolve()
            })
            socket.on('data', (chunk) => {
                buffer += chunk.toString()
                if (Buffer.byteLength(buffer) > 65536) {
                    socket.destroy(new Error('Oversized helper reply'))
                    return
                }
                while (buffer.includes('\n')) {
                    const end = buffer.indexOf('\n')
                    const line = buffer.slice(0, end)
                    buffer = buffer.slice(end + 1)
                    try {
                        const message = JSON.parse(line)
                        const pending = this.pending.get(message.id)
                        if (!pending) continue
                        this.pending.delete(message.id)
                        clearTimeout(pending.timer)
                        if (message.error) pending.reject(new Error(String(message.error)))
                        else if (
                            typeof message.result?.buildID !== 'string' ||
                            typeof message.result?.tunRunning !== 'boolean' ||
                            (message.result?.tunError !== undefined &&
                                typeof message.result.tunError !== 'string')
                        )
                            pending.reject(new Error('Invalid helper reply'))
                        else pending.resolve(message.result)
                    } catch {
                        socket.destroy(new Error('Invalid helper reply'))
                        return
                    }
                }
            })
            let failure = new Error('Helper connection closed')
            socket.on('error', (error) => {
                failure = error
                reject(error)
            })
            socket.once('close', () => {
                clearTimeout(timeout)
                reject(failure)
                if (this.socket === socket) this.socket = undefined
                for (const pending of this.pending.values()) {
                    clearTimeout(pending.timer)
                    pending.reject(failure)
                }
                this.pending.clear()
                this.disconnected(failure)
            })
        }).finally(() => {
            this.connecting = undefined
        })
        return this.connecting
    }
    async request(method: string, params: unknown = null, timeout = 10000): Promise<Reply> {
        await this.connect()
        const id = ++this.sequence
        return new Promise<Reply>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                reject(new Error(`Helper ${method} timed out`))
                // Never leave an uncertain privileged operation running without its owner.
                this.close()
            }, timeout)
            this.pending.set(id, { resolve, reject, timer })
            this.socket!.write(JSON.stringify({ id, token: this.token, method, params }) + '\n')
        })
    }
    get busy() {
        return this.pending.size > 0
    }
    close() {
        this.socket?.destroy()
    }
}
export function installationScript(
    stage: string,
    manifest: Manifest,
    pairingHash: string,
    plistHash: string
) {
    const base = `/Library/PrivilegedHelperTools/${helperID}`
    const plist = `/Library/LaunchDaemons/${helperID}.plist`
    // Fresh root-owned staging prevents the app from changing installed files after validation.
    // Expected hashes are part of the single command the user authorizes.
    return `set -eu
umask 077
/bin/mkdir -p /Library/PrivilegedHelperTools
root=$(/usr/bin/mktemp -d /Library/PrivilegedHelperTools/fluxy-install.XXXXXX)
trap '/bin/rm -rf "$root"' EXIT
/usr/bin/install -m 500 ${shellQuote(join(stage, 'fluxy-helper'))} "$root/fluxy-helper"
/usr/bin/install -m 500 ${shellQuote(join(stage, 'sing-box'))} "$root/sing-box"
[ "$(/usr/bin/shasum -a 256 "$root/fluxy-helper" | /usr/bin/cut -d ' ' -f 1)" = ${shellQuote(manifest.helperSHA256)} ]
[ "$(/usr/bin/shasum -a 256 "$root/sing-box" | /usr/bin/cut -d ' ' -f 1)" = ${shellQuote(manifest.coreSHA256)} ]
/usr/bin/install -m 400 ${shellQuote(join(stage, 'pairing.json'))} "$root/pairing.json"
/usr/bin/install -m 644 ${shellQuote(join(stage, 'service.plist'))} "$root/service.plist"
[ "$(/usr/bin/shasum -a 256 "$root/pairing.json" | /usr/bin/cut -d ' ' -f 1)" = ${shellQuote(pairingHash)} ]
[ "$(/usr/bin/shasum -a 256 "$root/service.plist" | /usr/bin/cut -d ' ' -f 1)" = ${shellQuote(plistHash)} ]
/usr/bin/plutil -lint "$root/service.plist" >/dev/null
/bin/launchctl bootout system/${helperID} 2>/dev/null || true
/bin/mkdir -p ${shellQuote(base)}
/usr/sbin/chown root:wheel ${shellQuote(base)}
/bin/chmod 700 ${shellQuote(base)}
/bin/mv -f "$root/fluxy-helper" ${shellQuote(base + '/fluxy-helper')}
/bin/mv -f "$root/sing-box" ${shellQuote(base + '/sing-box')}
/bin/mv -f "$root/pairing.json" ${shellQuote(base + '/pairing.json')}
/bin/mv -f "$root/service.plist" ${shellQuote(plist)}
/bin/launchctl enable system/${helperID}
/bin/launchctl bootstrap system ${shellQuote(plist)}
/bin/launchctl kickstart system/${helperID}`
}
// Runs the bundled helper as the logged-in desktop user. The helper itself owns
// whatever macOS dialog the requested operation needs.
function runBundledHelper(
    helperPath: string,
    args: string[],
    input: string,
    failure: string
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const worker = spawn(helperPath, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 180000
        })
        let output = ''
        worker.stdout.on('data', (b) => {
            output = (output + b.toString()).slice(-16384)
        })
        worker.stderr.on('data', (b) => {
            output = (output + b.toString()).slice(-16384)
        })
        worker.once('error', reject)
        worker.once('close', (code) =>
            code === 0 ? resolve() : reject(new Error(output.trim() || failure))
        )
        worker.stdin.on('error', () => {})
        worker.stdin.end(input)
    })
}
export function authorizeInstallation(
    command: string,
    helperPath: string,
    certificate?: Buffer
): Promise<void> {
    if (process.platform === 'win32') return authorizeWindowsSetup(helperPath, command)
    if (process.platform !== 'darwin') return authorizePortable(command)
    return runBundledHelper(
        helperPath,
        ['authorize-desktop'],
        JSON.stringify({ command, certificate: certificate?.toString('base64') }),
        'Native helper setup canceled or failed'
    )
}
// macOS root CA trust in the user domain. com.apple.trust-settings.user is granted
// by the session owner, so this needs no elevation and presents exactly one dialog.
// The admin domain would also need root for the System keychain, and its
// authenticate-admin rule (allow-root false, timeout 0) adds a second, uncacheable
// dialog that no pre-authorization can absorb.
export function desktopCertificate(
    action: 'trust-ca-desktop' | 'untrust-ca-desktop',
    helperPath: string,
    certificate: Buffer
): Promise<void> {
    return runBundledHelper(
        helperPath,
        [action],
        JSON.stringify(certificate.toString('base64')),
        action === 'trust-ca-desktop'
            ? 'Certificate installation canceled or failed'
            : 'Certificate removal canceled or failed'
    )
}
export function certificateScript(
    action: 'install' | 'remove',
    removal: {
        certificate: Buffer
        helperPath: string
        helperSHA256: string
    }
) {
    if (!/^[a-f0-9]{64}$/.test(removal.helperSHA256)) throw new Error('Invalid helper checksum')
    // Copy the verified bundled helper to root-owned storage before executing it.
    // Certificate operations never connect to or start the installed service.
    return `set -eu
cleanup=$(/usr/bin/mktemp -d /private/tmp/fluxy-certificate.XXXXXX)
trap '/bin/rm -rf "$cleanup"' EXIT
/bin/cp ${shellQuote(removal.helperPath)} "$cleanup/fluxy-helper"
[ "$(/usr/bin/shasum -a 256 "$cleanup/fluxy-helper" | /usr/bin/awk '{print $1}')" = ${shellQuote(removal.helperSHA256)} ] || { echo 'Helper checksum mismatch' >&2; exit 1; }
/bin/chmod 700 "$cleanup/fluxy-helper"
"$cleanup/fluxy-helper" ${action === 'install' ? 'trust-ca-privileged' : 'remove-ca-privileged'} <<'FLUXY_PUBLIC_CA'
"${removal.certificate.toString('base64')}"
FLUXY_PUBLIC_CA
`
}
export function uninstallationScript() {
    // Only remove fixed Electron helper paths; certificate removal is independent.
    const base = `/Library/PrivilegedHelperTools/${helperID}`
    const plist = `/Library/LaunchDaemons/${helperID}.plist`
    const runtime = `/private/var/run/${helperID}`
    return `set -eu
pid=''
if /bin/launchctl print system/${helperID} >/dev/null 2>&1; then
    pid=$(/bin/launchctl print system/${helperID} | /usr/bin/awk '$1 == "pid" && $2 == "=" { print $3; exit }')
    if ! /bin/launchctl bootout system/${helperID}; then
        if /bin/launchctl print system/${helperID} >/dev/null 2>&1; then
            echo 'Could not unload Helper service; uninstall stopped' >&2
            exit 1
        fi
    fi
fi
attempts=0
while /bin/launchctl print system/${helperID} >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then
        echo 'Helper service did not unload within 30 seconds; uninstall stopped' >&2
        exit 1
    fi
    /bin/sleep 1
done
case "$pid" in
    ''|*[!0-9]*) ;;
    *)
        attempts=0
        while /bin/kill -0 "$pid" 2>/dev/null; do
            attempts=$((attempts + 1))
            if [ "$attempts" -ge 30 ]; then
                echo 'Helper is still stopping; uninstall stopped' >&2
                exit 1
            fi
            /bin/sleep 1
        done
        ;;
esac
/bin/rm -f ${shellQuote(plist)}
/bin/rm -rf ${shellQuote(base)} ${shellQuote(runtime)}
/bin/rm -f ${shellQuote(helperSocket)}`
}
export class HelperService {
    status: HelperStatus = { state: supportedHelperPlatform() ? 'missing' : 'unsupported' }
    private rpc?: HelperRPC
    private installing?: Promise<void>
    private uninstalling?: Promise<void>
    private removed = false
    private operations = 0
    private heartbeat?: NodeJS.Timeout
    private manifest?: Manifest
    private closing = false
    private trusting?: Promise<void>
    private revoking = false
    onTunFailure?: (error: Error) => void
    private tunActive = false
    constructor(
        private directory: string,
        private helperPath: string,
        private corePath: string,
        private changed: () => void,
        private socketPath = helperSocket,
        private authorize = (command: string, certificate?: Buffer) =>
            authorizeInstallation(command, this.helperPath, certificate),
        private trustDesktop = (
            action: 'trust-ca-desktop' | 'untrust-ca-desktop',
            certificate: Buffer
        ) => desktopCertificate(action, this.helperPath, certificate)
    ) {}
    private setStatus(status: HelperStatus) {
        this.status = status
        this.changed()
    }
    private async assets(requireCore = true) {
        const manifest = JSON.parse(await readFile(this.helperPath + '.json', 'utf8')) as Manifest
        if (
            manifest.version !== 1 ||
            !/^[a-f0-9]{64}$/.test(manifest.buildID) ||
            digest(await readFile(this.helperPath)) !== manifest.helperSHA256 ||
            (requireCore && digest(await readFile(this.corePath)) !== manifest.coreSHA256)
        )
            throw new Error('Helper bundle integrity check failed; rebuild Fluxy')
        if (requireCore) this.manifest = manifest
        return manifest
    }
    private async client() {
        if (this.rpc) return this.rpc
        const { token } = JSON.parse(
            await readFile(join(this.directory, 'helper-client.json'), 'utf8')
        )
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
            throw new Error('Invalid helper pairing; reinstall Helper Tool')
        const rpc = new HelperRPC(this.socketPath, token, (error) => {
            if (
                this.rpc !== rpc ||
                this.closing ||
                this.status.state === 'installing' ||
                this.uninstalling
            )
                return
            this.setStatus(
                (error as NodeJS.ErrnoException).code === 'ENOENT'
                    ? { state: 'missing' }
                    : { state: 'error', error: error.message }
            )
            if (this.tunActive) {
                this.tunActive = false
                this.onTunFailure?.(error)
            }
        })
        this.rpc = rpc
        return rpc
    }
    async refresh(): Promise<HelperStatus> {
        if (!supportedHelperPlatform()) return this.status
        if (this.installing || this.uninstalling || this.rpc?.busy) return this.status
        try {
            const manifest = this.manifest ?? (await this.assets())
            const reply = await (await this.client()).request('status')
            this.setStatus({
                state: reply.buildID === manifest.buildID ? 'ready' : 'outdated',
                version: reply.buildID.slice(0, 12)
            })
            this.startHeartbeat()
        } catch (error) {
            this.setStatus({
                state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'error',
                ...((error as NodeJS.ErrnoException).code === 'ENOENT'
                    ? {}
                    : { error: String(error).replace(/^Error: /, '') })
            })
        }
        return this.status
    }
    private startHeartbeat() {
        if (this.heartbeat) return
        this.heartbeat = setInterval(() => {
            if (
                this.rpc?.busy ||
                (this.status.state !== 'ready' && this.status.state !== 'outdated')
            )
                return
            void this.rpc
                ?.request('status')
                .then((reply) => {
                    if (this.tunActive && !reply.tunRunning) {
                        this.tunActive = false
                        this.onTunFailure?.(
                            new Error(reply.tunError || 'Helper TUN core exited unexpectedly')
                        )
                    }
                })
                .catch(() => {})
        }, 5000)
        this.heartbeat.unref()
    }
    async ensureInstalled() {
        if (this.uninstalling) throw new Error('Helper Tool is being uninstalled')
        if (this.installing) return this.installing
        await this.refresh()
        if (this.uninstalling) throw new Error('Helper Tool is being uninstalled')
        if (this.installing) return this.installing
        if (this.status.state === 'ready') return
        if (this.status.state === 'missing' || this.status.state === 'outdated')
            throw new Error(
                'Helper Tool needs installation or update. Complete Helper Setup before starting capture.'
            )
        throw new Error(
            this.status.error || 'Helper unavailable; open Helper Tool to repair installation'
        )
    }
    install(certificate?: Buffer): Promise<void> {
        if (this.trusting) return Promise.reject(new Error('Wait for certificate trust to finish'))
        if (this.uninstalling) return Promise.reject(new Error('Helper Tool is being uninstalled'))
        if (this.installing) return this.installing
        if (this.status.state === 'ready')
            return certificate ? this.installCertificate(certificate) : Promise.resolve()
        if (this.tunActive) return Promise.reject(new Error('Stop TUN before updating Helper Tool'))
        this.installing = this.performInstall(certificate).finally(() => {
            this.installing = undefined
        })
        return this.installing
    }
    private async performInstall(certificate?: Buffer) {
        this.removed = false
        this.setStatus({ state: 'installing' })
        let stage: string | undefined
        try {
            if (!supportedHelperPlatform()) throw new Error('Unsupported helper platform')
            const manifest = await this.assets()
            await mkdir(this.directory, { recursive: true, mode: 0o700 })
            let token: string
            try {
                token = JSON.parse(
                    await readFile(join(this.directory, 'helper-client.json'), 'utf8')
                ).token
            } catch {
                token = randomBytes(32).toString('hex')
            }
            if (!/^[a-f0-9]{64}$/.test(token)) token = randomBytes(32).toString('hex')
            await writeFile(join(this.directory, 'helper-client.json'), JSON.stringify({ token }), {
                mode: 0o600
            })
            await chmod(join(this.directory, 'helper-client.json'), 0o600)
            stage = await mkdtemp(join(this.directory, 'helper-install-'))
            await copyFile(this.helperPath, join(stage, 'fluxy-helper'))
            await copyFile(this.corePath, join(stage, 'sing-box'))
            const signing =
                process.platform === 'darwin'
                    ? await promisify(execFile)('/usr/bin/codesign', [
                          '-d',
                          '--verbose=4',
                          process.execPath
                      ]).catch(() => ({ stderr: '' }))
                    : { stderr: '' }
            const teamID = signing.stderr.match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1] ?? null
            const caller = {
                path: process.execPath,
                sha256: digest(await readFile(process.execPath)),
                teamID,
                ...(process.platform === 'linux' && process.env.APPIMAGE ? { portable: true } : {})
            }
            await writeFile(
                join(stage, 'pairing.json'),
                JSON.stringify({
                    uid: process.getuid?.() ?? -1,
                    ...(process.platform === 'win32'
                        ? { sid: await currentSID(this.helperPath) }
                        : {}),
                    token,
                    buildID: manifest.buildID,
                    caller
                }),
                { mode: 0o600 }
            )
            await writeFile(
                join(stage, 'service.plist'),
                `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${helperID}</string>
<key>ProgramArguments</key><array><string>/Library/PrivilegedHelperTools/${helperID}/fluxy-helper</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ProcessType</key><string>Interactive</string>
<key>ExitTimeOut</key><integer>20</integer>
<key>ThrottleInterval</key><integer>5</integer>
</dict></plist>`,
                { mode: 0o600 }
            )
            this.rpc?.close()
            this.rpc = undefined
            const pairingHash = digest(await readFile(join(stage, 'pairing.json')))
            const command =
                process.platform === 'darwin'
                    ? `/bin/sh -c ${shellQuote(installationScript(stage, manifest, pairingHash, digest(await readFile(join(stage, 'service.plist')))))}`
                    : process.platform === 'win32'
                      ? windowsInstallationRequest(stage, manifest, pairingHash)
                      : portableInstallationScript(stage, manifest, pairingHash)
            await this.authorize(command, certificate)
            let lastError: unknown
            for (let attempt = 0; attempt < 40; attempt++) {
                try {
                    const reply = await (await this.client()).request('status')
                    if (reply.buildID !== manifest.buildID)
                        throw new Error('Helper version does not match this app')
                    this.setStatus({ state: 'ready', version: reply.buildID.slice(0, 12) })
                    this.startHeartbeat()
                    return
                } catch (error) {
                    lastError = error
                    await delay(500)
                }
            }
            throw lastError
        } catch (error) {
            this.setStatus({ state: 'error', error: String(error).replace(/^Error: /, '') })
            throw error
        } finally {
            if (stage) await rm(stage, { recursive: true, force: true })
        }
    }
    repair(): Promise<void> {
        if (this.trusting) return Promise.reject(new Error('Wait for certificate trust to finish'))
        if (this.uninstalling) return Promise.reject(new Error('Helper Tool is being uninstalled'))
        if (this.installing) return this.installing
        if (this.tunActive)
            return Promise.reject(new Error('Stop TUN before resetting Helper Tool'))
        this.setStatus({ state: 'outdated' })
        return this.install()
    }
    uninstall(): Promise<void> {
        if (this.uninstalling) return this.uninstalling
        if (this.removed) return Promise.resolve()
        if (!supportedHelperPlatform())
            return Promise.reject(new Error('Unsupported helper platform'))
        if (this.installing || this.operations || this.trusting)
            return Promise.reject(new Error('Wait for the current Helper Tool operation to finish'))
        if (this.tunActive)
            return Promise.reject(new Error('Stop TUN before uninstalling Helper Tool'))
        this.uninstalling = this.performUninstall().finally(() => {
            this.uninstalling = undefined
        })
        return this.uninstalling
    }
    private async performUninstall() {
        this.setStatus({ state: 'uninstalling' })
        clearInterval(this.heartbeat)
        this.heartbeat = undefined
        const rpc = this.rpc
        this.rpc = undefined
        rpc?.close()
        try {
            await this.authorize(
                process.platform === 'darwin'
                    ? `/bin/sh -c ${shellQuote(uninstallationScript())}`
                    : process.platform === 'win32'
                      ? JSON.stringify({ action: 'uninstall' })
                      : portableUninstallationScript()
            )
            // Keep the pairing token on cancellation/failure so repair still works.
            await rm(join(this.directory, 'helper-client.json'), { force: true })
            this.removed = true
            this.manifest = undefined
            this.setStatus({ state: 'missing' })
        } catch (error) {
            this.setStatus({
                state: 'error',
                error: `Helper uninstall failed: ${String(error).replace(/^Error: /, '')}`
            })
            throw error
        }
    }
    private async operation(
        method: string,
        params: unknown,
        timeout: number,
        requireCurrent = true
    ) {
        if (this.uninstalling) throw new Error('Helper Tool is being uninstalled')
        this.operations++
        try {
            if (requireCurrent) await this.ensureInstalled()
            const reply = await (await this.client()).request(method, params, timeout)
            if (method === 'tun.start') {
                if (!reply.tunRunning)
                    throw new Error(
                        reply.tunError || 'Helper TUN core exited before becoming ready'
                    )
                this.tunActive = true
            }
            return reply
        } finally {
            this.operations--
        }
    }
    async removeCertificate(der: Buffer) {
        if (this.installing) throw new Error('Wait for Helper Tool installation to finish')
        if (this.trusting) throw new Error('Wait for certificate trust to finish')
        if (this.uninstalling) throw new Error('Helper Tool is being uninstalled')
        this.revoking = true
        this.trusting = (async () => {
            if (process.platform === 'darwin') {
                await this.desktopCertificate('untrust-ca-desktop', der)
                return
            }
            if (process.platform === 'win32') {
                await this.authorizeCertificate(der, 'remove')
                return
            }
            await this.operation('ca.remove', der.toString('base64'), 90000, false)
        })().finally(() => {
            this.trusting = undefined
            this.revoking = false
        })
        return this.trusting
    }
    // Releases before the user trust domain installed the CA system-wide; only root
    // can clear that record, so it keeps the elevated path for existing machines.
    async removeLegacyCertificate(der: Buffer) {
        if (process.platform !== 'darwin') return
        if (this.installing) throw new Error('Wait for Helper Tool installation to finish')
        if (this.trusting) throw new Error('Wait for certificate trust to finish')
        if (this.uninstalling) throw new Error('Helper Tool is being uninstalled')
        this.revoking = true
        this.trusting = this.authorizeCertificate(der, 'remove').finally(() => {
            this.trusting = undefined
            this.revoking = false
        })
        return this.trusting
    }
    private async authorizeCertificate(der: Buffer, action: 'install' | 'remove') {
        const manifest = await this.assets(false)
        if (this.closing) throw new Error('Fluxy is closing')
        if (process.platform === 'win32') {
            await this.authorize(
                JSON.stringify({
                    action: `${action}-certificate`,
                    certificate: der.toString('base64')
                })
            )
            return
        }
        const script = certificateScript(action, {
            certificate: der,
            helperPath: this.helperPath,
            helperSHA256: manifest.helperSHA256
        })
        await this.authorize(`/bin/sh -c ${shellQuote(script)}`)
    }
    private async desktopCertificate(
        action: 'trust-ca-desktop' | 'untrust-ca-desktop',
        der: Buffer
    ) {
        await this.assets(false)
        if (this.closing) throw new Error('Fluxy is closing')
        await this.trustDesktop(action, der)
    }
    installCertificate(der: Buffer): Promise<void> {
        if (this.revoking)
            return Promise.reject(new Error('Wait for certificate trust removal to finish'))
        if (this.trusting) return this.trusting
        this.trusting = (async () => {
            if (process.platform === 'win32') {
                await this.authorizeCertificate(der, 'install')
                return
            }
            if (process.platform !== 'darwin') {
                await this.operation('ca.install', der.toString('base64'), 90000)
                return
            }
            // One macOS dialog, no elevation, and no Helper installation required.
            await this.desktopCertificate('trust-ca-desktop', der)
        })().finally(() => {
            this.trusting = undefined
        })
        return this.trusting
    }
    async startTun(params: unknown) {
        return this.operation('tun.start', params, process.platform === 'win32' ? 60000 : 30000)
    }
    async openTunInspector(params: { password: string; [key: string]: unknown }) {
        const reply = await this.startTun(params)
        let socket: net.Socket | undefined
        try {
            if (
                !Number.isInteger(reply.controlPort) ||
                reply.controlPort! < 1024 ||
                reply.controlPort! > 65535
            )
                throw new Error('Helper does not support the integrated inspector; update Helper')
            const stream = (socket = net.createConnection(reply.controlPort!, '127.0.0.1'))
            await new Promise<void>((resolve, reject) => {
                let received = Buffer.alloc(0)
                const failed = (error: Error) => {
                    cleanup()
                    reject(error)
                }
                const closed = () =>
                    failed(new Error('Helper inspector channel closed during authentication'))
                const timer = setTimeout(
                    () => failed(new Error('Helper inspector authentication timed out')),
                    10000
                )
                const cleanup = () => {
                    clearTimeout(timer)
                    stream.off('error', failed)
                    stream.off('close', closed)
                    stream.off('data', data)
                }
                const data = (chunk: Buffer) => {
                    received = Buffer.concat([received, chunk])
                    if (received.length < 3) return
                    if (received.subarray(0, 3).toString() !== 'OK\n')
                        return failed(new Error('Helper inspector authentication failed'))
                    stream.pause()
                    cleanup()
                    if (received.length > 3) stream.unshift(received.subarray(3))
                    resolve()
                }
                stream.on('error', failed).on('close', closed).on('data', data)
                stream.once('connect', () => stream.write(params.password + '\n'))
            })
            return {
                stream,
                ready: async () => {
                    await this.operation('tun.ready', null, 30000)
                },
                close: async () => {
                    stream.destroy()
                }
            }
        } catch (error) {
            socket?.destroy()
            await this.stopTun().catch(() => {})
            throw error
        }
    }
    async stopTun() {
        if (!this.rpc) return
        this.operations++
        this.tunActive = false
        try {
            await this.rpc.request('tun.stop', null, process.platform === 'win32' ? 45000 : 20000)
        } catch (error) {
            this.rpc.close()
            throw error
        } finally {
            this.operations--
        }
    }
    close() {
        this.closing = true
        clearInterval(this.heartbeat)
        this.rpc?.close()
        return this.uninstalling?.catch(() => {})
    }
}
