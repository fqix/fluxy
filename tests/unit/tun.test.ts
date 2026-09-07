import { describe, expect, it } from 'vitest'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import dgram from 'node:dgram'
import forge from 'node-forge'
import { Store } from '../../src/main/store'
import { ProxyEngine } from '../../src/main/proxy'
import { TunBridge, connect, openTunnel } from '../../src/main/tun-bridge'
import { tunConfig } from '../../src/main/tun-config'
import { TunService, unusedPort } from '../../src/main/tun'
import { tunSettingsSchema } from '../../src/shared/model'

const execute = promisify(execFile)
const core = join(process.cwd(), 'build/electron-core/fluxy-core')
const curl = (port: number, url: string, extra: string[] = []) =>
    execute(
        '/usr/bin/curl',
        [
            '--silent',
            '--show-error',
            '--fail',
            '--max-time',
            '10',
            '--noproxy',
            '',
            '--socks5-hostname',
            `127.0.0.1:${port}`,
            ...extra,
            url
        ],
        { timeout: 15000 }
    )

describe('TUN configuration', () => {
    it('keeps egress ahead of inspection and validates explicit routes', () => {
        const settings = tunSettingsSchema.parse({
            socksPort: 7897,
            routeCIDRs: ['203.0.113.0/24', '2001:db8::/32']
        })
        const config = tunConfig({
            settings,
            bridgePort: 18001,
            egressPort: 18002,
            password: 'private',
            interfaceName: 'utun2345',
            egressInterface: 'en0'
        })
        expect(config.route.rules[0]).toEqual({
            inbound: ['egress'],
            action: 'route',
            outbound: 'direct'
        })
        expect(config.inbounds[0]).toMatchObject({
            type: 'tun',
            auto_route: true,
            dns_mode: 'disabled',
            route_address: settings.routeCIDRs
        })
        expect(config.outbounds[0]).toMatchObject({
            type: 'socks',
            server: '127.0.0.1',
            server_port: 7897
        })
        expect(() => tunSettingsSchema.parse({ routeCIDRs: ['not-a-route'] })).toThrow()
        expect(() => tunSettingsSchema.parse({ interface: 'en0; touch /tmp/injected' })).toThrow()
        expect(() => tunSettingsSchema.parse({ socksPort: 80 })).toThrow()
    })
})

describe.skipIf(process.platform !== 'darwin')(
    'bundled TUN transport without route changes',
    () => {
        it('captures HTTP POST and CA-verified HTTPS through the real core and isolated egress', async () => {
            const directory = await mkdtemp(join(tmpdir(), 'fluxy-tun-transport-'))
            const store = new Store(directory)
            store.settings.port = await unusedPort()
            const keys = forge.pki.rsa.generateKeyPair(2048)
            const cert = forge.pki.createCertificate()
            cert.publicKey = keys.publicKey
            cert.serialNumber = '01'
            cert.validity.notBefore = new Date(Date.now() - 60000)
            cert.validity.notAfter = new Date(Date.now() + 86400000)
            cert.setSubject([{ name: 'commonName', value: 'localhost' }])
            cert.setIssuer(cert.subject.attributes)
            cert.setExtensions([
                { name: 'basicConstraints', cA: true },
                { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }
            ])
            cert.sign(keys.privateKey, forge.md.sha256.create())
            const ca = forge.pki.certificateToPem(cert)
            const handler: http.RequestListener = (req, res) => {
                const chunks: Buffer[] = []
                req.on('data', (b) => chunks.push(b))
                req.on('end', () => res.end(`TUN ${req.url} ${Buffer.concat(chunks)}`))
            }
            const origin = http.createServer(handler)
            const secure = https.createServer(
                { cert: ca, key: forge.pki.privateKeyToPem(keys.privateKey) },
                handler
            )
            origin.listen(0)
            secure.listen(0)
            await Promise.all([once(origin, 'listening'), once(secure, 'listening')])
            const originPort = (origin.address() as net.AddressInfo).port
            const securePort = (secure.address() as net.AddressInfo).port
            const engine = new ProxyEngine(store, () => {}, new https.Agent({ ca }))
            const egressPort = await unusedPort(),
                capturePort = await unusedPort()
            const egressURL = `http://fluxy:token@127.0.0.1:${egressPort}`
            const bridge = new TunBridge(
                store.settings.port,
                egressURL,
                'token',
                (host) => host === 'localhost'
            )
            await bridge.start()
            const config = join(directory, 'config.json')
            await writeFile(
                config,
                JSON.stringify(
                    tunConfig({
                        settings: store.settings.tun,
                        bridgePort: bridge.port,
                        egressPort,
                        password: 'token',
                        interfaceName: 'unused',
                        egressInterface: '',
                        socksTestPort: capturePort
                    })
                )
            )
            await execute(core, ['check', '-c', config])
            engine.setTransportEgress(egressURL)
            await engine.start()
            let logs = ''
            const worker = spawn(core, ['run', '-c', config])
            worker.stdout.on('data', (b) => (logs += b))
            worker.stderr.on('data', (b) => (logs += b))
            try {
                await expect
                    .poll(async () => {
                        if (worker.exitCode !== null) throw new Error(`Core exited: ${logs}`)
                        try {
                            const s = await connect(egressPort)
                            s.destroy()
                            return true
                        } catch {
                            return false
                        }
                    })
                    .toBe(true)
                const post = await curl(capturePort, `http://localhost:${originPort}/post`, [
                    '--data-binary',
                    'preserved body'
                ])
                expect(post.stdout).toBe('TUN /post preserved body')
                const tls = await curl(capturePort, `https://localhost:${securePort}/secure`, [
                    '--cacert',
                    engine.certificatePath
                ])
                expect(tls.stdout).toBe('TUN /secure ')
                await expect
                    .poll(
                        () =>
                            [...engine.transactions.values()].filter((t) => t.state === 'completed')
                                .length
                    )
                    .toBe(2)
                expect(
                    [...engine.transactions.values()].find((t) => t.path === '/post')?.requestBody
                ).toBe('preserved body')
                expect(
                    [...engine.transactions.values()].find((t) => t.path === '/secure')?.ssl
                ).toBe(true)
                // Uninspected CONNECT still goes through core egress rather than looping through TUN.
                store.settings.ssl = false
                const tunnel = await openTunnel(
                    `http://127.0.0.1:${store.settings.port}`,
                    'localhost',
                    originPort
                )
                tunnel.write(
                    `GET /passthrough HTTP/1.1\r\nHost: localhost:${originPort}\r\nConnection: close\r\n\r\n`
                )
                let body = ''
                for await (const chunk of tunnel) body += chunk.toString()
                expect(body).toContain('TUN /passthrough ')
                await expect(
                    openTunnel(
                        `http://fluxy:wrong@127.0.0.1:${bridge.port}`,
                        'localhost',
                        originPort
                    )
                ).rejects.toThrow('CONNECT failed')
                const udpOrigin = dgram.createSocket('udp4')
                const udpClient = dgram.createSocket('udp4')
                const control = await connect(capturePort)
                try {
                    udpOrigin.on('message', (message, peer) =>
                        udpOrigin.send(message, peer.port, peer.address)
                    )
                    udpOrigin.bind(0, '127.0.0.1')
                    await once(udpOrigin, 'listening')
                    const udpPort = udpOrigin.address().port
                    const read = async (count: number) => {
                        let data: Buffer | null
                        while (!(data = control.read(count) as Buffer | null))
                            await once(control, 'readable')
                        return data
                    }
                    control.write(Buffer.from([5, 1, 0]))
                    expect(await read(2)).toEqual(Buffer.from([5, 0]))
                    control.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]))
                    const reply = await read(10)
                    expect(reply[1]).toBe(0)
                    const relayPort = reply.readUInt16BE(8)
                    const datagram = Buffer.concat([
                        Buffer.from([0, 0, 0, 1, 127, 0, 0, 1, udpPort >> 8, udpPort & 255]),
                        Buffer.from('TUN UDP echo')
                    ])
                    udpClient.send(datagram, relayPort, '127.0.0.1')
                    const [response] = await Promise.race([
                        once(udpClient, 'message'),
                        delay(5000).then(() => {
                            throw new Error('UDP echo timed out')
                        })
                    ])
                    expect((response as Buffer).subarray(10).toString()).toBe('TUN UDP echo')
                } finally {
                    control.destroy()
                    udpOrigin.close()
                    udpClient.close()
                }
                expect(logs).not.toMatch(/fatal|panic/)
            } finally {
                worker.kill('SIGTERM')
                await once(worker, 'close')
                await engine.stop()
                await bridge.stop()
                origin.closeAllConnections()
                secure.closeAllConnections()
                await Promise.all([
                    new Promise<void>((r) => origin.close(() => r())),
                    new Promise<void>((r) => secure.close(() => r()))
                ])
                await rm(directory, { recursive: true, force: true })
            }
        }, 30000)
        it('reports a missing core without starting capture or rewriting preferences', async () => {
            const directory = await mkdtemp(join(tmpdir(), 'fluxy-tun-missing-'))
            const store = new Store(directory)
            const engine = new ProxyEngine(store, () => {})
            const service = new TunService(store, engine, join(directory, 'missing'), () => {})
            const original = structuredClone(store.settings)
            try {
                await expect(service.start()).rejects.toThrow('TUN core unavailable')
                expect(service.status.state).toBe('error')
                expect(engine.running).toBe(false)
                expect(store.settings).toEqual(original)
            } finally {
                await service.stop()
                await rm(directory, { recursive: true, force: true })
            }
        })
    }
)
