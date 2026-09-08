import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import net from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { TunBridge, connect } from './tun-bridge'
import { tunConfig } from './tun-config'
import type { HelperService } from '../system/helper'
import { matchPattern, type TunStatus } from '../../shared/contracts/model'
import type { Store } from '../storage/store'
import type { ProxyEngine } from '../capture/proxy'

import { routeInterface, tunInterfaceName } from './tun-platform'
import { waitForSplitDNSRemoval, type SplitDNS } from './split-dns'
import { supportedHelperPlatform } from '../system/helper-platform'

const execute = promisify(execFile)
export async function unusedPort() {
    const server = net.createServer()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return port
}
export class TunService {
    splitDNS?: SplitDNS
    status: TunStatus = { state: 'stopped', available: false }
    private helperStarted = false
    private bridge?: TunBridge
    private directory?: string
    private canceled = false
    private starting?: Promise<void>
    private stopping?: Promise<void>
    private ownsEngine = false
    private ownedInterface?: string
    private workerOutput = ''
    constructor(
        private store: Store,
        private engine: ProxyEngine,
        readonly corePath: string,
        private changed: () => void,
        private helper?: HelperService
    ) {
        if (helper)
            helper.onTunFailure = (error) => {
                this.workerOutput = error.message
                if (this.status.state === 'running') void this.stopAfterFailure()
            }
    }
    private setStatus(patch: Partial<TunStatus>) {
        this.status = { ...this.status, ...patch }
        this.changed()
    }
    async checkCore() {
        try {
            if (!supportedHelperPlatform()) throw new Error('Unsupported TUN platform')
            await access(this.corePath, constants.X_OK)
            const manifest = JSON.parse(await readFile(this.corePath + '.build.json', 'utf8'))
            const hash = createHash('sha256')
                .update(await readFile(this.corePath))
                .digest('hex')
            if (
                manifest.version !== '1.14.0' ||
                (manifest.signedSHA256 ?? manifest.unsignedSHA256) !== hash
            )
                throw new Error('Bundled TUN core integrity check failed; rebuild Fluxy')
            const { stdout } = await execute(this.corePath, ['version'], { timeout: 10000 })
            if (!stdout.startsWith('sing-box version 1.14.0\n'))
                throw new Error('Unsupported TUN core version')
            this.setStatus({ available: true })
        } catch (error) {
            this.setStatus({ available: false, error: `TUN core unavailable: ${String(error)}` })
        }
    }
    start(): Promise<void> {
        if (this.starting) return this.starting
        if (this.status.state === 'running') return Promise.resolve()
        if (this.stopping) return Promise.reject(new Error('TUN is still stopping'))
        if (this.ownedInterface || this.helperStarted)
            return Promise.reject(new Error('Stop the previous TUN session before restarting'))
        this.canceled = false
        this.starting = this.launch().finally(() => {
            this.starting = undefined
        })
        return this.starting
    }
    private async launch() {
        this.setStatus({
            state: 'starting',
            error: undefined,
            interfaceName: undefined,
            splitDNS: !!this.splitDNS
        })
        try {
            await this.checkCore()
            if (!this.status.available) throw new Error(this.status.error)
            const settings = this.store.settings.tun
            if (this.store.settings.upstream.enabled)
                throw new Error(
                    'Disable Upstream Proxy before starting TUN. Set the TUN SOCKS5 exit port instead.'
                )
            let egressInterface = settings.interface
            if (settings.socksPort) {
                if (settings.socksPort === this.store.settings.port)
                    throw new Error('TUN exit cannot point to Fluxy itself')
                const probe = await connect(settings.socksPort)
                probe.destroy()
            } else if (!egressInterface && !this.splitDNS) {
                egressInterface = await routeInterface('default')
                const routes = await Promise.all(
                    ['1.1.1.1', '198.18.0.1'].map((destination) => routeInterface(destination))
                )
                if (
                    egressInterface.startsWith('utun') ||
                    routes.some((name) => name !== egressInterface)
                )
                    throw new Error(
                        'An existing VPN or split route is active. Select its local SOCKS5 exit port or an explicit network interface.'
                    )
            }
            if (!this.splitDNS && !settings.socksPort && !networkInterfaces()[egressInterface])
                throw new Error('Selected exit interface is unavailable')
            if (this.canceled) throw new Error('TUN start canceled')
            if (!this.helper) throw new Error('Helper Tool is unavailable')
            await this.helper.ensureInstalled()
            if (this.canceled) throw new Error('TUN start canceled')
            await this.engine.stop()
            const parent = join(this.store.directory, 'tun')
            await mkdir(parent, { recursive: true, mode: 0o700 })
            this.directory = await mkdtemp(join(parent, 'run-'))
            const password = randomBytes(32).toString('base64url')
            const egressPort = await unusedPort()
            const egress = `http://fluxy:${password}@127.0.0.1:${egressPort}`
            this.bridge = new TunBridge(
                this.store.settings.port,
                egress,
                password,
                (host) =>
                    this.store.settings.ssl &&
                    this.store.settings.sslHosts.some((pattern) => matchPattern(pattern, host))
            )
            await this.bridge.start()
            let interfaceName: string
            do {
                interfaceName = tunInterfaceName(randomInt(2000, 60000))
            } while (networkInterfaces()[interfaceName])
            this.ownedInterface = interfaceName
            this.setStatus({ interfaceName })
            const config = join(this.directory, 'config.json')
            await writeFile(
                config,
                JSON.stringify(
                    tunConfig({
                        settings,
                        bridgePort: this.bridge.port,
                        egressPort,
                        password,
                        interfaceName,
                        egressInterface,
                        splitDNS: this.splitDNS
                    })
                ),
                { mode: 0o600 }
            )
            await execute(this.corePath, ['check', '-c', config], { timeout: 15000 })
            this.ownsEngine = true
            this.engine.setTransportEgress(egress)
            await this.engine.start()
            if (this.canceled) throw new Error('TUN start canceled')
            this.workerOutput = ''
            this.helperStarted = true
            await this.helper.startTun({
                bridgePort: this.bridge.port,
                egressPort,
                password,
                interfaceName,
                egressInterface,
                socksPort: settings.socksPort,
                routeCIDRs: settings.routeCIDRs,
                ...(this.splitDNS ? { splitDNS: this.splitDNS } : {})
            })
            const deadline = Date.now() + 30000
            while (Date.now() < deadline) {
                if (this.canceled) throw new Error('TUN start canceled')
                if (this.workerOutput)
                    throw new Error(
                        this.workerOutput.trim() || 'TUN core exited before becoming ready'
                    )
                if (networkInterfaces()[interfaceName]) {
                    try {
                        const probe = await connect(egressPort)
                        probe.destroy()
                        this.setStatus({
                            state: 'running',
                            interfaceName,
                            error: undefined,
                            splitDNS: !!this.splitDNS
                        })
                        this.engine.log(
                            `TUN started on ${interfaceName}; exit ${this.splitDNS ? 'existing routes with Split DNS / Fake IP' : settings.socksPort ? `SOCKS5 127.0.0.1:${settings.socksPort}` : egressInterface}`
                        )
                        return
                    } catch {
                        /* Wait for all core inbounds. */
                    }
                }
                await delay(150)
            }
            throw new Error('TUN start timed out')
        } catch (error) {
            const message = String(error).replace(/^Error: /, '')
            try {
                await this.cleanup()
            } catch (cleanupError) {
                this.setStatus({ state: 'error', error: `${message}; ${String(cleanupError)}` })
                throw cleanupError
            }
            this.setStatus({ state: 'error', error: message })
            throw error
        }
    }
    private async stopAfterFailure() {
        const message = this.workerOutput.trim() || 'TUN core stopped unexpectedly'
        try {
            await this.stop()
            this.setStatus({ state: 'error', error: message })
        } catch (error) {
            this.setStatus({ state: 'error', error: String(error) })
        }
        this.engine.log(message, 'error')
    }
    stop(): Promise<void> {
        if (this.status.state === 'stopped' && !this.starting) return Promise.resolve()
        if (this.stopping) return this.stopping
        this.canceled = true
        this.stopping = (async () => {
            if (this.starting) await this.starting.catch(() => {})
            this.setStatus({ state: 'stopping' })
            try {
                await this.cleanup()
                this.setStatus({ state: 'stopped', interfaceName: undefined, error: undefined })
            } catch (error) {
                this.setStatus({ state: 'error', error: String(error) })
                throw error
            }
        })().finally(() => {
            this.stopping = undefined
        })
        return this.stopping
    }
    private async cleanup() {
        if (this.helperStarted) {
            try {
                await this.helper?.stopTun()
            } catch (error) {
                // A disconnected lease is cleaned up by the daemon. Wait for that
                // postcondition before allowing proxy traffic to bypass core egress.
                const deadline = Date.now() + 25000
                while (
                    this.ownedInterface &&
                    networkInterfaces()[this.ownedInterface] &&
                    Date.now() < deadline
                )
                    await delay(150)
                if (this.ownedInterface && networkInterfaces()[this.ownedInterface]) throw error
            }
        }
        if (this.splitDNS && this.ownedInterface) await waitForSplitDNSRemoval(this.ownedInterface)
        this.helperStarted = false
        if (this.ownedInterface && networkInterfaces()[this.ownedInterface])
            throw new Error('TUN interface still exists; keep Fluxy open and retry Stop')
        if (this.ownsEngine) {
            await this.engine.stop()
            this.engine.setTransportEgress(undefined)
            this.ownsEngine = false
        }
        await this.bridge?.stop()
        this.bridge = undefined
        if (this.directory) await rm(this.directory, { recursive: true, force: true })
        this.directory = undefined
        this.ownedInterface = undefined
        this.setStatus({ interfaceName: undefined, splitDNS: false })
    }
}
