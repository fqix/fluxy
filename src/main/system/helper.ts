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
    currentSID,
    portableInstallationScript,
    portableUninstallationScript
} from './helper-platform'

export const helperID = 'dev.fengqi.fluxy.electron.helper'
export const helperSocket = helperEndpoint()
interface Reply {
    buildID: string
    tunRunning: boolean
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
                            typeof message.result?.tunRunning !== 'boolean'
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
/usr/bin/install -m 500 ${shellQuote(join(stage, 'fluxy-core'))} "$root/fluxy-core"
[ "$(/usr/bin/shasum -a 256 "$root/fluxy-helper" | /usr/bin/cut -d ' ' -f 1)" = ${shellQuote(manifest.helperSHA256)} ]
[ "$(/usr/bin/shasum -a 256 "$root/fluxy-core" | /usr/bin/cut -d ' ' -f 1)" = ${shellQuote(manifest.coreSHA256)} ]
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
/bin/mv -f "$root/fluxy-core" ${shellQuote(base + '/fluxy-core')}
/bin/mv -f "$root/pairing.json" ${shellQuote(base + '/pairing.json')}
/bin/mv -f "$root/service.plist" ${shellQuote(plist)}
/bin/launchctl enable system/${helperID}
/bin/launchctl bootstrap system ${shellQuote(plist)}
/bin/launchctl kickstart system/${helperID}`
}
export function authorizeInstallation(command: string): Promise<void> {
    if (process.platform !== 'darwin') return authorizePortable(command)
    return new Promise<void>((resolve, reject) => {
        const worker = spawn(
            '/usr/bin/osascript',
            ['-e', `do shell script ${JSON.stringify(command)} with administrator privileges`],
            { stdio: ['ignore', 'pipe', 'pipe'] }
        )
        let output = ''
        worker.stdout.on('data', (b) => {
            output = (output + b.toString()).slice(-16384)
        })
        worker.stderr.on('data', (b) => {
            output = (output + b.toString()).slice(-16384)
        })
        worker.once('error', reject)
        worker.once('close', (code) =>
            code === 0
                ? resolve()
                : reject(new Error(output.trim() || 'Helper installation canceled or failed'))
        )
    })
}
export function uninstallationScript() {
    // Fixed Electron-only paths. Never remove certificates, user preferences,
    // another Fluxy distribution's helper, or arbitrary caller-supplied paths.
    const base = `/Library/PrivilegedHelperTools/${helperID}`
    const plist = `/Library/LaunchDaemons/${helperID}.plist`
    const runtime = `/private/var/run/${helperID}`
    return `set -eu
pid=''
if /bin/launchctl print system/${helperID} >/dev/null 2>&1; then
    pid=$(/bin/launchctl print system/${helperID} | /usr/bin/awk '$1 == "pid" && $2 == "=" { print $3; exit }')
    /bin/launchctl bootout system/${helperID}
fi
if /bin/launchctl print system/${helperID} >/dev/null 2>&1; then
    echo 'Helper service is still loaded; uninstall stopped' >&2
    exit 1
fi
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
    onTunFailure?: (error: Error) => void
    private tunActive = false
    constructor(
        private directory: string,
        private helperPath: string,
        private corePath: string,
        private changed: () => void,
        private socketPath = helperSocket,
        private authorize = authorizeInstallation
    ) {}
    private setStatus(status: HelperStatus) {
        this.status = status
        this.changed()
    }
    private async assets() {
        const manifest = JSON.parse(await readFile(this.helperPath + '.json', 'utf8')) as Manifest
        if (
            manifest.version !== 1 ||
            !/^[a-f0-9]{64}$/.test(manifest.buildID) ||
            digest(await readFile(this.helperPath)) !== manifest.helperSHA256 ||
            digest(await readFile(this.corePath)) !== manifest.coreSHA256
        )
            throw new Error('Helper bundle integrity check failed; rebuild Fluxy')
        this.manifest = manifest
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
                        this.onTunFailure?.(new Error('Helper TUN core exited unexpectedly'))
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
            return this.install()
        throw new Error(
            this.status.error || 'Helper unavailable; open Helper Tool to repair installation'
        )
    }
    install(): Promise<void> {
        if (this.uninstalling) return Promise.reject(new Error('Helper Tool is being uninstalled'))
        if (this.installing) return this.installing
        if (this.status.state === 'ready') return Promise.resolve()
        if (this.tunActive) return Promise.reject(new Error('Stop TUN before updating Helper Tool'))
        this.installing = this.performInstall().finally(() => {
            this.installing = undefined
        })
        return this.installing
    }
    private async performInstall() {
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
            await copyFile(this.corePath, join(stage, 'fluxy-core'))
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
                    ...(process.platform === 'win32' ? { sid: await currentSID() } : {}),
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
                    : portableInstallationScript(stage, manifest, pairingHash)
            await this.authorize(command)
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
        if (this.installing || this.operations)
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
    private async operation(method: string, params: unknown, timeout: number) {
        if (this.uninstalling) throw new Error('Helper Tool is being uninstalled')
        this.operations++
        try {
            await this.ensureInstalled()
            const reply = await (await this.client()).request(method, params, timeout)
            if (method === 'tun.start') this.tunActive = true
            return reply
        } finally {
            this.operations--
        }
    }
    async removeCertificate(der: Buffer) {
        await this.operation('ca.remove', der.toString('base64'), 90000)
    }
    async installCertificate(der: Buffer) {
        await this.operation('ca.install', der.toString('base64'), 90000)
    }
    async startTun(params: unknown) {
        await this.operation('tun.start', params, 30000)
    }
    async stopTun() {
        if (!this.rpc) return
        this.operations++
        this.tunActive = false
        try {
            await this.rpc.request('tun.stop', null, 20000)
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
