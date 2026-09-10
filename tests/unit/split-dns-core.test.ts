import { describe, expect, it } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import dgram from 'node:dgram'
import { Resolver } from 'node:dns/promises'
import forge from 'node-forge'
import { Store } from '../../src/main/storage/store'
import { ProxyEngine } from '../../src/main/capture/proxy'
import { TunBridge, connect } from '../../src/main/tun/tun-bridge'
import { tunConfig } from '../../src/main/tun/tun-config'
import { unusedPort } from '../../src/main/tun/tun'

// Uses real core and DNS packets, with loopback inbounds instead of privileged TUN/routes.
describe.skipIf(process.platform !== 'darwin')('Fake IP DNS and capture integration', () => {
    it('allocates A/AAAA locally, restores domains, inspects HTTP/TLS, and resolves real egress outside Fake IP', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'fluxy-fakeip-'))
        const store = new Store(directory)
        store.settings.port = await unusedPort()
        const name = 'fakeip.fluxy.test'
        const keys = forge.pki.rsa.generateKeyPair(2048)
        const cert = forge.pki.createCertificate()
        cert.publicKey = keys.publicKey
        cert.serialNumber = '01'
        cert.validity.notBefore = new Date(Date.now() - 60000)
        cert.validity.notAfter = new Date(Date.now() + 86400000)
        cert.setSubject([{ name: 'commonName', value: name }])
        cert.setIssuer(cert.subject.attributes)
        cert.setExtensions([
            { name: 'basicConstraints', cA: true },
            { name: 'subjectAltName', altNames: [{ type: 2, value: name }] }
        ])
        cert.sign(keys.privateKey, forge.md.sha256.create())
        const ca = forge.pki.certificateToPem(cert)
        const handler: http.RequestListener = (req, res) => res.end(`captured ${req.url}`)
        const origin = http.createServer(handler)
        const secure = https.createServer(
            { cert: ca, key: forge.pki.privateKeyToPem(keys.privateKey) },
            handler
        )
        const upstreamDNS = dgram.createSocket('udp4')
        let upstreamQueries = 0
        upstreamDNS.on('message', (query, remote) => {
            upstreamQueries++
            const response = Buffer.from(query)
            response.writeUInt16BE(0x8180, 2)
            const type = query.readUInt16BE(query.length - 4)
            response.writeUInt16BE(type === 1 ? 1 : 0, 6)
            const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, 127, 0, 0, 1])
            upstreamDNS.send(
                type === 1 ? Buffer.concat([response, answer]) : response,
                remote.port,
                remote.address
            )
        })
        origin.listen(0, '127.0.0.1')
        secure.listen(0, '127.0.0.1')
        upstreamDNS.bind(0, '127.0.0.1')
        await Promise.all([
            once(origin, 'listening'),
            once(secure, 'listening'),
            once(upstreamDNS, 'listening')
        ])
        const originPort = (origin.address() as net.AddressInfo).port
        const securePort = (secure.address() as net.AddressInfo).port
        const egressPort = await unusedPort(),
            capturePort = await unusedPort(),
            dnsPort = await unusedPort()
        const engine = new ProxyEngine(store, () => {}, new https.Agent({ ca }))
        const egress = `http://fluxy:token@127.0.0.1:${egressPort}`
        const bridge = new TunBridge(store.settings.port, egress, 'token', () => true)
        await bridge.start()
        const config: any = tunConfig({
            settings: store.settings.tun,
            splitDNS: {
                server: '127.0.0.1',
                ipv4Range: '198.19.0.0/16',
                domains: ['fakeip.fluxy.test']
            },
            bridgePort: bridge.port,
            egressPort,
            password: 'token',
            interfaceName: 'unused',
            egressInterface: '',
            socksTestPort: capturePort
        })
        config.dns.servers[0].server_port = upstreamDNS.address().port
        config.inbounds[0].tag = 'capture-traffic'
        config.inbounds.push({
            type: 'direct',
            tag: 'capture',
            listen: '127.0.0.1',
            listen_port: dnsPort,
            override_port: 53
        })
        const path = join(directory, 'config.json')
        await writeFile(path, JSON.stringify(config))
        const core = join(process.cwd(), 'build/electron-core/sing-box')
        const execute = promisify(execFile)
        await execute(core, ['check', '-c', path])
        engine.setTransportEgress(egress)
        await engine.start()
        const child = spawn(core, ['run', '-c', path])
        let logs = ''
        child.stdout.on('data', (data) => (logs += data))
        child.stderr.on('data', (data) => (logs += data))
        try {
            await expect
                .poll(async () => {
                    if (child.exitCode !== null) throw new Error(logs)
                    try {
                        ;(await connect(egressPort)).destroy()
                        return true
                    } catch {
                        return false
                    }
                })
                .toBe(true)
            const resolver = new Resolver({ timeout: 1000, tries: 1 })
            resolver.setServers([`127.0.0.1:${dnsPort}`])
            const [fake] = await resolver.resolve4(name)
            expect(fake).toMatch(/^198\.19\./)
            const [fake6] = await resolver.resolve6(name)
            expect(fake6).toMatch(/^fd7a:115c:a1e0:/)
            expect(upstreamQueries).toBe(0)
            expect((await resolver.resolve4(`api.${name}`))[0]).toMatch(/^198\.19\./)
            expect(upstreamQueries).toBe(0)
            expect(await resolver.resolve4('unrelated.fluxy.test')).toEqual(['127.0.0.1'])
            expect(await resolver.resolve4(`not${name}`)).toEqual(['127.0.0.1'])
            expect(upstreamQueries).toBeGreaterThan(0)
            for (const [scheme, port, path] of [
                ['http', originPort, '/plain'],
                ['https', securePort, '/secure']
            ] as const) {
                const result = await execute('/usr/bin/curl', [
                    '--silent',
                    '--show-error',
                    '--fail',
                    '--max-time',
                    '5',
                    '--noproxy',
                    '',
                    '--socks5',
                    `127.0.0.1:${capturePort}`,
                    '--resolve',
                    `${name}:${port}:${fake}`,
                    '--cacert',
                    engine.certificatePath,
                    `${scheme}://${name}:${port}${path}`
                ])
                expect(result.stdout).toBe(`captured ${path}`)
            }
            await expect
                .poll(
                    () =>
                        [...engine.transactions.values()].filter((t) => t.state === 'completed')
                            .length
                )
                .toBe(2)
            expect([...engine.transactions.values()].map((t) => t.host)).toEqual([name, name])
            expect(upstreamQueries).toBeGreaterThan(0)
            expect(JSON.parse(await readFile(path, 'utf8')).outbounds[0]).toEqual({
                type: 'direct',
                tag: 'direct'
            })
        } finally {
            const exited = child.exitCode === null ? once(child, 'exit') : Promise.resolve()
            child.kill('SIGTERM')
            await exited
            await bridge.stop()
            await engine.stop()
            origin.closeAllConnections()
            secure.closeAllConnections()
            await Promise.all([
                new Promise<void>((r) => origin.close(() => r())),
                new Promise<void>((r) => secure.close(() => r()))
            ])
            upstreamDNS.close()
            await rm(directory, { recursive: true, force: true })
        }
    })
})
