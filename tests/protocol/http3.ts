import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Duplex } from 'node:stream'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { startProxy } from './engine'
import { ruleSchema } from '../../src/shared/contracts/model'
import { toHAR, fromHAR } from '../../src/shared/traffic/har'
import { bundledCorePath, proxyIngressConfig } from '../../src/main/capture/sing-box-proxy'

const execute = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), 'fluxy-h3-'))
const binary = join(directory, process.platform === 'win32' ? 'http3-fixture.exe' : 'http3-fixture')
try {
    await execute(
        process.env.FLUXY_GO || 'go',
        ['build', '-o', binary, resolve('tests/protocol/http3-fixture.go')],
        {
            cwd: resolve('third_party/sing-box'),
            env: { ...process.env, GOTOOLCHAIN: 'go1.27.1', GOWORK: 'off' }
        }
    )
    const origin = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    const events: any[] = []
    const lines = createInterface({ input: origin.stdout })
    let originError = ''
    origin.stderr.on('data', (data) => {
        originError += data
    })
    lines.on('line', (line) => events.push(JSON.parse(line)))
    const waitFor = async <T>(read: () => T | undefined) => {
        for (let i = 0; i < 250; i++) {
            const result = read()
            if (result !== undefined) return result
            await delay(20)
        }
        throw new Error(`HTTP/3 fixture timed out: ${originError}`)
    }
    try {
        const ready = await waitFor(() => events.find((event) => event.type === 'ready'))
        const proxy = await startProxy(ready.ca, [])
        const ca = join(directory, 'fluxy.pem')
        const originCA = join(directory, 'origin.pem')
        await writeFile(ca, proxy.ca)
        await writeFile(originCA, ready.ca)
        const request = async (path: string, body: Buffer, trust = ca) => {
            const { stdout } = await execute(
                binary,
                [
                    'request',
                    `127.0.0.1:${proxy.port}`,
                    `https://127.0.0.1:${ready.port}${path}`,
                    trust,
                    body.toString('base64')
                ],
                { timeout: 15000 }
            )
            return JSON.parse(stdout)
        }
        const capture = (path: string) =>
            waitFor(() =>
                [...proxy.engine.transactions.values()].find(
                    (item) => item.url.endsWith(path) && item.state === 'completed'
                )
            )
        try {
            const body = Buffer.from([0, 1, 127, 128, 255])
            const response = await request('/binary', body)
            assert.equal(response.status, 200, proxy.logs())
            assert.equal(response.version, 'HTTP/3.0')
            assert.deepEqual(Buffer.from(response.body, 'base64'), body)
            assert.deepEqual(response.trailers['X-Finished'], ['yes'])
            const captured = await capture('/binary')
            assert.equal(captured.httpVersion, '3.0')
            assert.deepEqual(Buffer.from(captured.requestBase64!, 'base64'), body)
            assert.deepEqual(Buffer.from(captured.responseBase64!, 'base64'), body)
            assert.equal(captured.responseTrailers?.['x-finished'], 'yes')
            const har = toHAR([captured])
            assert.equal(har.log.entries[0].request.httpVersion, 'HTTP/3.0')
            const imported = fromHAR(har)[0]
            assert.equal(imported.httpVersion, '3.0')
            assert.equal(imported.responseTrailers?.['x-finished'], 'yes')
            console.log(
                'PASS HTTP/3: SOCKS UDP ingress, verified MITM, binary capture and trailers'
            )

            proxy.engine.store.rules = [
                ruleSchema.parse({
                    id: randomUUID(),
                    name: 'H3 request header',
                    enabled: true,
                    kind: 'requestHeader',
                    pattern: '*',
                    header: 'x-test',
                    value: 'modified'
                }),
                ruleSchema.parse({
                    id: randomUUID(),
                    name: 'H3 response header',
                    enabled: true,
                    kind: 'responseHeader',
                    pattern: '*',
                    header: 'x-response',
                    value: 'modified'
                })
            ]
            const edited = await request('/headers', Buffer.from('headers'))
            assert.deepEqual(edited.headers['X-Origin-Request-Edit'], ['modified'])
            assert.deepEqual(edited.headers['X-Response'], ['modified'])
            proxy.engine.store.rules = []
            proxy.engine.store.scripts = ['request', 'response'].map((phase) => ({
                id: randomUUID(),
                name: phase,
                enabled: true,
                pattern: '*',
                phase: phase as 'request' | 'response',
                code: ''
            }))
            proxy.engine.scriptRunner = async (script, message) => ({
                ...message,
                body: `${script.phase}-edited`
            })
            const scripted = await request('/scripts', Buffer.from('original'))
            assert.equal(Buffer.from(scripted.body, 'base64').toString(), 'response-edited')
            const hit = events.find((event) => event.path === '/scripts')
            assert.equal(Buffer.from(hit.body, 'base64').toString(), 'request-edited')
            await capture('/scripts')
            proxy.engine.store.scripts = []
            console.log('PASS HTTP/3: application request/response rules and body scripts')

            proxy.engine.store.rules = [
                ruleSchema.parse({
                    id: randomUUID(),
                    name: 'H3 breakpoint',
                    enabled: true,
                    kind: 'breakpoint',
                    pattern: '*/breakpoint',
                    phase: 'both'
                })
            ]
            const pending = request('/breakpoint', Buffer.from('paused'))
            pending.catch(() => {})
            for (const phase of ['request', 'response'] as const) {
                const transaction = await waitFor(() =>
                    [...proxy.engine.transactions.values()].find(
                        (item) =>
                            item.url.endsWith('/breakpoint') &&
                            item.state === 'paused' &&
                            item.breakpointPhase === phase
                    )
                )
                proxy.engine.resolveBreakpoint(transaction.id, 'continue')
            }
            assert.equal((await pending).status, 200)
            await capture('/breakpoint')
            proxy.engine.store.rules = []
            const cancelled = await request('/cancel', Buffer.alloc(0))
            assert.equal(Buffer.from(cancelled.body, 'base64').toString(), 'first')
            await waitFor(() => events.find((event) => event.type === 'cancelled'))
            console.log('PASS HTTP/3: request/response breakpoints and streamed cancellation')

            proxy.engine.store.settings.sslHosts = ['excluded.example']
            const bypassed = await request('/bypass', body, originCA)
            assert.deepEqual(Buffer.from(bypassed.body, 'base64'), body)
            assert.equal(
                [...proxy.engine.transactions.values()].some((item) =>
                    item.url.endsWith('/bypass')
                ),
                false
            )
            console.log('PASS HTTP/3: excluded SSL host stays encrypted and uses passthrough')
        } finally {
            await proxy.stop()
        }
        // Exercise the same in-process packet egress used by the Helper. The
        // deliberately unavailable TCP route must never be used for H3.
        const tunProxy = await startProxy(ready.ca, [], (engine) => {
            engine.setTransportEgress('http://127.0.0.1:1')
            engine.inspectorControl = async () => {
                const config = proxyIngressConfig('127.0.0.1', engine.store.settings.port)
                const file = join(directory, 'tun-core.json')
                await writeFile(
                    file,
                    JSON.stringify({
                        ...config,
                        services: [
                            { type: 'fluxy-inspector', tag: 'inspector', packet_egress: 'direct' }
                        ],
                        outbounds: [...config.outbounds, { type: 'direct', tag: 'direct' }]
                    })
                )
                const core = spawn(bundledCorePath(), ['run', '-c', file], {
                    stdio: ['pipe', 'pipe', 'pipe']
                })
                core.stderr.on('data', () => {})
                const exited = new Promise<void>((resolve) => core.once('exit', () => resolve()))
                return {
                    stream: Duplex.from({ readable: core.stdout, writable: core.stdin }),
                    ready: async () => {},
                    close: async () => {
                        core.kill()
                        await exited
                    }
                }
            }
        })
        try {
            await writeFile(ca, tunProxy.ca)
            const { stdout } = await execute(
                binary,
                [
                    'request',
                    `127.0.0.1:${tunProxy.port}`,
                    `https://127.0.0.1:${ready.port}/tun-egress`,
                    ca,
                    Buffer.from('tun').toString('base64')
                ],
                { timeout: 15000 }
            )
            const result = JSON.parse(stdout)
            assert.equal(result.status, 200, tunProxy.logs())
            assert.equal(Buffer.from(result.body, 'base64').toString(), 'tun')
            console.log('PASS HTTP/3: Helper-style packet egress bypasses the TCP bridge')
            const quic = await execute(
                binary,
                [
                    'quic',
                    `127.0.0.1:${tunProxy.port}`,
                    `127.0.0.1:${ready.quicPort}`,
                    originCA,
                    Buffer.from('non-http-quic').toString('base64')
                ],
                { timeout: 15000 }
            )
            assert.equal(
                Buffer.from(JSON.parse(quic.stdout).body, 'base64').toString(),
                'non-http-quic'
            )
            console.log('PASS QUIC: non-HTTP ALPN retains encrypted passthrough in TUN mode')
        } finally {
            await tunProxy.stop()
        }
    } finally {
        origin.stdin.end()
        origin.kill()
        lines.close()
    }
} finally {
    await rm(directory, { recursive: true, force: true })
}
