import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { spawn } from 'node:child_process'
import https from 'node:https'
import forge from 'node-forge'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { gzipSync } from 'node:zlib'
import net from 'node:net'
import tls from 'node:tls'
import { WebSocketServer, WebSocket } from 'ws'
import { Store } from '../../src/main/storage/store'
import { CustomCertificates } from '../../src/main/certificates/custom-certificates'
import { ensureCertificate } from '../../src/main/certificates/certificates'
import { ProxyEngine } from '../../src/main/capture/proxy'
import { ruleSchema, type Rule } from '../../src/shared/contracts/model'
let directory: string,
    store: Store,
    engine: ProxyEngine,
    origin: http.Server,
    originPort: number,
    port: number
let hits: { url?: string; headers: http.IncomingHttpHeaders; body: string }[]
async function freePort() {
    const s = net.createServer()
    s.listen(0, '127.0.0.1')
    await once(s, 'listening')
    const p = (s.address() as net.AddressInfo).port
    await new Promise<void>((r) => s.close(() => r()))
    return p
}
function request(path = '/hello', body = '', method = 'GET') {
    return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>(
        (resolve, reject) => {
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port,
                    path: `http://127.0.0.1:${originPort}${path}`,
                    method,
                    headers: {
                        host: `127.0.0.1:${originPort}`,
                        'user-agent': 'curl/test',
                        ...(body ? { 'content-length': Buffer.byteLength(body) } : {})
                    }
                },
                (res) => {
                    const chunks: Buffer[] = []
                    res.on('error', reject)
                    res.on('data', (b) => chunks.push(b))
                    res.on('end', () =>
                        resolve({
                            status: res.statusCode!,
                            body: Buffer.concat(chunks).toString(),
                            headers: res.headers
                        })
                    )
                }
            )
            req.on('error', reject)
            req.end(body)
        }
    )
}
function rule(kind: Rule['kind'], extra: Partial<Rule> = {}) {
    return ruleSchema.parse({
        id: randomUUID(),
        name: `Test ${kind}`,
        enabled: true,
        kind,
        pattern: '*',
        ...extra
    })
}
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fluxy-test-'))
    port = await freePort()
    store = new Store(directory)
    store.settings.port = port
    hits = []
    origin = http.createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (b) => chunks.push(b))
        req.on('end', () => {
            hits.push({
                url: req.url,
                headers: req.headers,
                body: Buffer.concat(chunks).toString()
            })
            res.setHeader('content-type', 'application/json')
            if (req.url === '/gzip') {
                res.setHeader('content-encoding', 'gzip')
                res.end(gzipSync('{"compressed":true}'))
            } else
                res.end(JSON.stringify({ path: req.url, body: Buffer.concat(chunks).toString() }))
        })
    })
    origin.listen(0, '127.0.0.1')
    await once(origin, 'listening')
    originPort = (origin.address() as net.AddressInfo).port
    engine = new ProxyEngine(store, () => {})
    await engine.start()
})
afterEach(async () => {
    await engine?.stop()
    origin?.closeAllConnections()
    await new Promise<void>((r) => origin?.close(() => r()))
    await rm(directory, { recursive: true, force: true })
})
describe('real proxy traffic', () => {
    it('caps request and response previews independently while forwarding complete bodies', async () => {
        store.settings.maxRequestBodyBytes = 4
        store.settings.maxResponseBodyBytes = 12
        const result = await request('/limits', '完整内容 is forwarded', 'POST')
        await waitFor(() => [...engine.transactions.values()][0]?.state === 'completed')
        const t = [...engine.transactions.values()][0]
        expect(hits[0].body).toBe('完整内容 is forwarded')
        expect(JSON.parse(result.body).body).toBe(hits[0].body)
        expect(t.requestBody).toBe(Buffer.from(hits[0].body).subarray(0, 4).toString('utf8'))
        expect(t.responseBody).toBe(result.body.slice(0, 12))
        expect(t.requestBytes).toBe(Buffer.byteLength(hits[0].body))
        expect(t.responseBytes).toBe(Buffer.byteLength(result.body))
        expect(t.truncated).toBe(true)
    })
    it('supports headers-only capture without changing traffic', async () => {
        store.settings.maxRequestBodyBytes = 0
        store.settings.maxResponseBodyBytes = 0
        const result = await request('/headers-only', 'forward me', 'POST')
        await waitFor(() => [...engine.transactions.values()][0]?.state === 'completed')
        const t = [...engine.transactions.values()][0]
        expect(JSON.parse(result.body).body).toBe('forward me')
        expect(t).toMatchObject({ requestBody: '', responseBody: '', truncated: true, status: 200 })
        expect(t.requestBase64).toBeUndefined()
        expect(t.responseBase64).toBeUndefined()
    })
    it('caps decompressed response previews as well as streamed response chunks', async () => {
        store.settings.maxResponseBodyBytes = 128
        const payload = 'decoded response '.repeat(100)
        origin.removeAllListeners('request')
        origin.on('request', (req, res) => {
            if (req.url === '/compressed-limit') {
                res.setHeader('content-type', 'text/plain')
                res.setHeader('content-encoding', 'gzip')
                res.end(gzipSync(payload))
            } else {
                res.setHeader('content-type', 'text/event-stream')
                res.write('data: ' + 'x'.repeat(500) + '\n\n')
                res.end('data: done\n\n')
            }
        })
        await request('/compressed-limit')
        await waitFor(() => [...engine.transactions.values()][0]?.state === 'completed')
        const compressed = [...engine.transactions.values()][0]
        expect(compressed.responseBody).toBe(payload.slice(0, 128))
        expect(compressed.truncated).toBe(true)
        const stream = await request('/stream-limit')
        await waitFor(() => [...engine.transactions.values()][1]?.state === 'completed')
        const streamed = [...engine.transactions.values()][1]
        expect(stream.body).toContain('data: done\n\n')
        expect(streamed.responseBody).toBe(stream.body.slice(0, 128))
        expect(streamed.truncated).toBe(true)
    })
    it('applies body limits to composed requests without truncating the sent request', async () => {
        store.settings.maxRequestBodyBytes = 3
        store.settings.maxResponseBodyBytes = 7
        const t = await engine.compose({
            url: `http://127.0.0.1:${originPort}/composed-limit`,
            method: 'POST',
            headers: {},
            body: 'all of this reaches the server'
        })
        expect(hits[0].body).toBe('all of this reaches the server')
        expect(t.requestBody).toBe('all')
        expect(t.responseBody).toHaveLength(7)
        expect(t.truncated).toBe(true)
    })
    it('captures HTTP through the local SOCKS5 endpoint and closes it on stop', async () => {
        await engine.stop()
        const socksPort = port
        store.settings.captureMode = 'proxy'
        await engine.start()
        const { stdout } = await promisify(execFile)('curl', [
            '--silent',
            '--show-error',
            '--max-time',
            '8',
            '--noproxy',
            '',
            '--socks5-hostname',
            `127.0.0.1:${socksPort}`,
            `http://127.0.0.1:${originPort}/via-socks`
        ])
        expect(stdout).toContain('/via-socks')
        expect((await request('/same-port-http')).status).toBe(200)
        await waitFor(() =>
            [...engine.transactions.values()].some(
                (t) => t.url.includes('/via-socks') && t.state === 'completed'
            )
        )
        await engine.stop()
        await expect(
            new Promise<void>((resolve, reject) => {
                const socket = net.connect(socksPort, '127.0.0.1')
                socket.once('connect', () => {
                    socket.destroy()
                    resolve()
                })
                socket.once('error', reject)
            })
        ).rejects.toThrow('ECONNREFUSED')
    })
    it('does not generate background update traffic while idle', async () => {
        // Upstream starts its registry version check one second after loading.
        // Embedded Fluxy must not capture its own maintenance requests.
        await new Promise((resolve) => setTimeout(resolve, 1600))
        expect([...engine.transactions.values()].map((t) => t.url)).toEqual([])
    })
    it('can stop and restart after the listen port is occupied', async () => {
        await engine.stop()
        const occupied = net.createServer()
        occupied.listen(port, '127.0.0.1')
        await once(occupied, 'listening')
        try {
            await expect(engine.start()).rejects.toThrow('EADDRINUSE')
            await expect(engine.stop()).resolves.toBeUndefined()
            expect(engine.running).toBe(false)
        } finally {
            await new Promise<void>((resolve) => occupied.close(() => resolve()))
        }
        await engine.start()
        expect((await request()).status).toBe(200)
    })
    it('forwards POST bodies and captures request/response metadata', async () => {
        const result = await request('/api', 'hello', 'POST')
        expect(result.status).toBe(200)
        expect(hits[0].body).toBe('hello')
        await waitFor(() => [...engine.transactions.values()][0]?.state === 'completed')
        const [t] = [...engine.transactions.values()]
        expect(t.requestBody).toBe('hello')
        expect(t.method).toBe('POST')
        expect(t.client).toBe('curl')
        expect(t.responseBody).toContain('/api')
        expect(t.state).toBe('completed')
    })
    it('decodes compressed capture without modifying forwarded bytes', async () => {
        const result = await request('/gzip')
        expect(result.headers['content-encoding']).toBe('gzip')
        await waitFor(() => [...engine.transactions.values()][0]?.state === 'completed')
        expect([...engine.transactions.values()][0].responseBody).toBe('{"compressed":true}')
    })
    it('blocks matching requests without reaching the upstream', async () => {
        store.rules = [rule('block')]
        expect((await request()).status).toBe(403)
        expect(hits).toHaveLength(0)
        expect([...engine.transactions.values()][0].state).toBe('blocked')
    })
    it('applies allow list before upstream forwarding', async () => {
        store.rules = [rule('allow', { pattern: '*/allowed' })]
        expect((await request('/denied')).status).toBe(403)
        expect((await request('/allowed')).status).toBe(200)
        expect(hits).toHaveLength(1)
    })
    it('maps local files and remote URLs', async () => {
        const file = join(directory, 'fixture.json')
        await writeFile(file, '{"local":true}')
        store.rules = [rule('mapLocal', { value: file })]
        expect((await request()).body).toBe('{"local":true}')
        expect(hits).toHaveLength(0)
        store.rules = [rule('mapRemote', { value: `http://127.0.0.1:${originPort}/rewritten` })]
        expect((await request()).body).toContain('/rewritten')
    })
    it('modifies request/response headers and bypasses cache', async () => {
        store.rules = [
            rule('requestHeader', { header: 'x-test', value: 'changed' }),
            rule('responseHeader', { header: 'x-response', value: 'yes' })
        ]
        store.settings.noCache = true
        const result = await request()
        expect(hits[0].headers['x-test']).toBe('changed')
        expect(hits[0].headers['cache-control']).toBe('no-cache')
        expect(result.headers['x-response']).toBe('yes')
        expect(result.headers['cache-control']).toBe('no-store')
    })
    it('identifies a real local client process independently of its user-agent', async () => {
        const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', [
            '--noproxy',
            '',
            '--proxy',
            `http://127.0.0.1:${port}`,
            '-A',
            'PretendBrowser',
            `http://127.0.0.1:${originPort}/identity`
        ])
        const output: Buffer[] = []
        child.stdout.on('data', (b) => output.push(b))
        expect((await once(child, 'exit'))[0]).toBe(0)
        const t = [...engine.transactions.values()][0]
        expect(t.clientSource).toBe('process')
        expect(t.clientPID).toBe(child.pid)
        expect(t.client).toBe('curl')
        expect(t.clientIdentity).toMatch(/^executable:/)
        expect(t.clientIdentity).not.toContain('/usr/')
    })
    it('pauses oversized bodies and preserves every byte while editing headers', async () => {
        store.rules = [rule('breakpoint')]
        const body = 'z'.repeat(2 * 1024 * 1024 + 100)
        const response = request('/large', body, 'POST')
        await waitFor(() => [...engine.transactions.values()].some((t) => t.state === 'paused'))
        const t = [...engine.transactions.values()][0]
        expect(t.breakpointBodyEditable).toBe(false)
        expect(() =>
            engine.resolveBreakpoint(t.id, 'continue', {
                url: t.url,
                method: 'POST',
                headers: {},
                body: 'overwrite'
            })
        ).toThrow('preserved')
        engine.resolveBreakpoint(t.id, 'continue', {
            url: t.url,
            method: 'POST',
            headers: { 'x-edited': 'yes' },
            body: '',
            preserveBody: true
        })
        expect((await response).status).toBe(200)
        expect(hits[0].body).toBe(body)
        expect(hits[0].headers['x-edited']).toBe('yes')
    })
    it('preserves binary bodies and repeated response headers at breakpoints', async () => {
        store.rules = [rule('breakpoint', { phase: 'both' })]
        const response = request('/binary', 'a\0b', 'POST')
        await waitFor(() =>
            [...engine.transactions.values()].some((t) => t.breakpointPhase === 'request')
        )
        const t = [...engine.transactions.values()][0]
        expect(t.breakpointBodyEditable).toBe(false)
        engine.resolveBreakpoint(t.id, 'continue', {
            url: t.url,
            method: 'POST',
            headers: { 'x-edited': 'yes' },
            body: '',
            preserveBody: true
        })
        await waitFor(() => t.breakpointPhase === 'response')
        engine.resolveBreakpoint(t.id, 'continue', {
            status: 202,
            headers: {},
            headerEntries: [
                { name: 'Set-Cookie', value: 'a=1' },
                { name: 'Set-Cookie', value: 'b=2' }
            ],
            body: 'changed'
        })
        const result = await response
        expect(hits[0].body).toBe('a\0b')
        expect(result.headers['set-cookie']).toEqual(['a=1', 'b=2'])
        expect(result.status).toBe(202)
        expect(result.body).toBe('changed')
    })
    it('validates all breakpoint drafts before applying the batch', async () => {
        store.rules = [rule('breakpoint')]
        const first = request('/a'),
            second = request('/b')
        await waitFor(
            () => [...engine.transactions.values()].filter((t) => t.state === 'paused').length === 2
        )
        const queue = [...engine.transactions.values()]
        const edits = queue.map((t) => ({
            id: t.id,
            edit: { url: t.url, method: 'GET', headers: { 'x-batch': 'yes' }, body: '' }
        }))
        expect(() =>
            engine.applyBreakpoints([
                edits[0],
                { ...edits[1], edit: { ...edits[1].edit, method: 'bad method' } }
            ])
        ).toThrow()
        expect(queue.every((t) => t.state === 'paused')).toBe(true)
        expect(hits).toHaveLength(0)
        engine.applyBreakpoints(edits)
        expect((await Promise.all([first, second])).map((r) => r.status)).toEqual([200, 200])
        expect(hits.every((hit) => hit.headers['x-batch'] === 'yes')).toBe(true)
    })
    it('continues and aborts the current queue as a batch', async () => {
        store.rules = [rule('breakpoint')]
        const first = request('/one'),
            second = request('/two')
        await waitFor(
            () => [...engine.transactions.values()].filter((t) => t.state === 'paused').length === 2
        )
        engine.resolveAllBreakpoints('continue')
        expect((await Promise.all([first, second])).map((r) => r.status)).toEqual([200, 200])
        const third = request('/three'),
            fourth = request('/four')
        await waitFor(
            () => [...engine.transactions.values()].filter((t) => t.state === 'paused').length === 2
        )
        engine.resolveAllBreakpoints('abort')
        expect((await Promise.all([third, fourth])).map((r) => r.status)).toEqual([503, 503])
        expect(hits).toHaveLength(2)
    })
    it('applies a native network preset and captures real timing phases', async () => {
        store.rules = [
            rule('networkCondition', {
                networkPreset: 'custom',
                delay: 100,
                uploadKbps: 128,
                downloadKbps: 128,
                pattern: '*/condition'
            })
        ]
        const started = Date.now()
        expect((await request('/condition', 'a'.repeat(4096), 'POST')).status).toBe(200)
        expect(Date.now() - started).toBeGreaterThanOrEqual(590)
        const t = [...engine.transactions.values()][0]
        expect(t.timings?.blocked).toBeGreaterThanOrEqual(100)
        expect(t.timings?.connect).toBeGreaterThanOrEqual(0)
        expect(t.timings?.wait).toBeGreaterThanOrEqual(0)
        expect(t.timings?.receive).toBeGreaterThanOrEqual(0)
        expect(t.timings?.total).toBe(t.duration)
        const other = Date.now()
        await request('/other')
        expect(Date.now() - other).toBeLessThan(500)
    })
    it('cancels delayed network requests when capture stops', async () => {
        store.rules = [rule('networkCondition', { networkPreset: 'custom', delay: 30000 })]
        const response = request('/stop-delay').catch(() => undefined)
        await waitFor(() => engine.transactions.size > 0)
        await engine.stop()
        await response
        expect(hits).toHaveLength(0)
    })
    it('finishes capture when the client receives the body before the upstream IPC end', async () => {
        // Hold upstream credit so the body reaches the client before its IPC end event.
        const transport = (
            engine as unknown as {
                proxy: { send: (message: Record<string, unknown>) => void }
            }
        ).proxy
        const send = transport.send.bind(transport)
        const credits: Record<string, unknown>[] = []
        transport.send = (message) => {
            if (message.type === 'credit' && String(message.stream).endsWith(':response:in'))
                credits.push(message)
            else send(message)
        }
        try {
            const result = await promisify(execFile)('curl', [
                '--silent',
                '--show-error',
                '--max-time',
                '8',
                '--noproxy',
                '',
                '--proxy',
                `http://127.0.0.1:${port}`,
                `http://127.0.0.1:${originPort}/hello`
            ])
            expect(result.stdout).toContain('/hello')
            expect(credits.length).toBeGreaterThan(0)
            // Let the child's downstream close event race ahead of the upstream end.
            await new Promise((resolve) => setTimeout(resolve, 100))
            transport.send = send
            for (const credit of credits.splice(0)) send(credit)
            await waitFor(() => [...engine.transactions.values()][0]?.state === 'completed')
            expect([...engine.transactions.values()][0].responseBody).toContain('/hello')
        } finally {
            transport.send = send
            for (const credit of credits.splice(0)) send(credit)
        }
    })
    it('marks a response interrupted before Content-Length as an error', async () => {
        origin.removeAllListeners('request')
        origin.on('request', (_req, res) => {
            res.writeHead(200, { 'content-length': 100 })
            res.write('partial')
        })
        await new Promise<void>((resolve, reject) => {
            const client = http.get(
                {
                    host: '127.0.0.1',
                    port,
                    path: `http://127.0.0.1:${originPort}/interrupted`
                },
                (res) => {
                    res.once('data', () => {
                        res.destroy()
                        resolve()
                    })
                    res.on('error', reject)
                }
            )
            client.on('error', reject)
        })
        await waitFor(() => [...engine.transactions.values()][0]?.state === 'error')
    })
    it('pauses then continues a request at a breakpoint', async () => {
        store.rules = [rule('breakpoint')]
        const pending = request()
        await waitFor(() => [...engine.transactions.values()].some((t) => t.state === 'paused'))
        expect(hits).toHaveLength(0)
        const t = [...engine.transactions.values()][0]
        engine.resolveBreakpoint(t.id, 'continue')
        expect((await pending).status).toBe(200)
        await waitFor(() => t.state === 'completed')
    })
    it('aborts paused traffic and keeps upstream untouched', async () => {
        store.rules = [rule('breakpoint')]
        const pending = request()
        await waitFor(() => [...engine.transactions.values()].some((t) => t.state === 'paused'))
        engine.resolveBreakpoint([...engine.transactions.keys()][0], 'abort')
        expect((await pending).status).toBe(503)
        expect(hits).toHaveLength(0)
    })
    it('aborts a response breakpoint without hanging the client', async () => {
        store.rules = [rule('breakpoint', { phase: 'response' })]
        const pending = request('/response-abort')
        await waitFor(() =>
            [...engine.transactions.values()].some((t) => t.breakpointPhase === 'response')
        )
        const transaction = [...engine.transactions.values()][0]
        engine.resolveBreakpoint(transaction.id, 'abort')
        expect((await pending).status).toBe(503)
        expect(transaction.state).toBe('blocked')
        expect(hits).toHaveLength(1)
    })
    it('edits a buffered POST and then its response at two-phase breakpoints', async () => {
        store.rules = [rule('breakpoint', { phase: 'both' })]
        const pending = request('/original', 'original body', 'POST')
        await waitFor(() =>
            [...engine.transactions.values()].some((t) => t.breakpointPhase === 'request')
        )
        const t = [...engine.transactions.values()][0]
        expect(t.requestBody).toBe('original body')
        engine.resolveBreakpoint(t.id, 'continue', {
            method: 'PUT',
            url: `http://127.0.0.1:${originPort}/edited`,
            headers: { 'x-edited': 'yes', 'content-length': '999' },
            body: 'replacement'
        })
        await waitFor(() => t.breakpointPhase === 'response')
        expect(hits[0].url).toBe('/edited')
        expect(hits[0].body).toBe('replacement')
        expect(hits[0].headers['content-length']).toBe('11')
        expect(t.responseBody).toContain('/edited')
        engine.resolveBreakpoint(t.id, 'continue', {
            status: 202,
            headers: { 'content-type': 'text/plain', 'content-length': '999' },
            body: 'response edited'
        })
        const result = await pending
        expect(result.status).toBe(202)
        expect(result.body).toBe('response edited')
        expect(result.headers['content-length']).not.toBe('999')
        expect(
            result.headers['content-length'] === String(Buffer.byteLength(result.body)) ||
                result.headers['transfer-encoding'] === 'chunked'
        ).toBe(true)
        expect(t.state).toBe('completed')
        expect(t.responseBody).toBe('response edited')
    })
    it('keeps POST bytes unchanged when continuing and bypasses rules for excluded hosts', async () => {
        store.rules = [rule('breakpoint')]
        const pending = request('/unchanged', 'body unchanged', 'POST')
        await waitFor(() => [...engine.transactions.values()].some((t) => t.state === 'paused'))
        engine.resolveBreakpoint([...engine.transactions.keys()][0], 'continue')
        await pending
        expect(hits[0].body).toBe('body unchanged')
        engine.clear()
        store.settings.fullBypassHosts = ['127.0.0.1']
        store.rules = [rule('block')]
        expect((await request()).status).toBe(200)
        expect(engine.transactions.size).toBe(0)
    })
    it('applies upload bandwidth limits to actual forwarded data', async () => {
        store.rules = [rule('throttle', { uploadKbps: 128 })]
        const start = Date.now()
        expect((await request('/throttled', 'a'.repeat(8192), 'POST')).status).toBe(200)
        expect(Date.now() - start).toBeGreaterThanOrEqual(480)
        expect(hits[0].body).toHaveLength(8192)
    })
    it('deleting paused traffic aborts it and never resurrects the row', async () => {
        store.rules = [rule('breakpoint', { phase: 'both' })]
        const pending = request()
        await waitFor(() => [...engine.transactions.values()].some((t) => t.state === 'paused'))
        engine.deleteTransactions([...engine.transactions.keys()])
        expect((await pending).status).toBe(503)
        expect(engine.transactions.size).toBe(0)
        expect(hits).toHaveLength(0)
    })
    it('applies download bandwidth limits without ending the response early', async () => {
        store.rules = [rule('throttle', { downloadKbps: 128 })]
        const start = Date.now()
        const result = await request('/download', 'a'.repeat(8192), 'POST')
        expect(result.status).toBe(200)
        expect(Date.now() - start).toBeGreaterThanOrEqual(480)
        expect(JSON.parse(result.body).body).toHaveLength(8192)
    })
    it('does not record paused capture, but continues forwarding', async () => {
        engine.recording = false
        expect((await request()).status).toBe(200)
        expect(engine.transactions.size).toBe(0)
    })
    it('reuses its certificate across restarts and releases the listen port', async () => {
        const cert = await readFile(engine.certificatePath, 'utf8')
        await engine.stop()
        await engine.start()
        expect(await readFile(engine.certificatePath, 'utf8')).toBe(cert)
        expect((await request()).status).toBe(200)
    })
    it.each(['HTTP CONNECT', 'SOCKS5'])(
        'exports a working CA for HTTPS MITM through %s on the shared port',
        async (protocol) => {
            const socket = net.connect(port, '127.0.0.1')
            await once(socket, 'connect')
            if (protocol === 'SOCKS5') {
                // Fragment the greeting to verify that protocol detection retains bytes.
                socket.write(Buffer.from([5]))
                await new Promise((resolve) => setTimeout(resolve, 10))
                socket.write(Buffer.from([1, 0]))
                const [greeting] = await once(socket, 'data')
                expect(greeting).toEqual(Buffer.from([5, 0]))
                socket.write(
                    Buffer.concat([
                        Buffer.from([5, 1, 0, 3, 11]),
                        Buffer.from('example.com'),
                        Buffer.from([1, 187])
                    ])
                )
                const [reply] = await once(socket, 'data')
                expect(reply[1]).toBe(0)
            } else {
                socket.write(`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n`)
                await once(socket, 'data')
            }
            const secure = tls.connect({
                socket,
                servername: 'example.com',
                ca: await readFile(engine.certificatePath)
            })
            await once(secure, 'secureConnect')
            expect(secure.authorized).toBe(true)
            expect(secure.getPeerCertificate().subject.CN).toBe('example.com')
            secure.destroy()
        }
    )
    it('decrypts HTTPS and authenticates upstream TLS with the configured client certificate', async () => {
        const root = forge.pki.certificateFromPem(await readFile(engine.certificatePath, 'utf8'))
        const keyPEM = await readFile(join(directory, 'certificates/keys/ca.private.key'), 'utf8')
        const key = forge.pki.privateKeyFromPem(keyPEM)
        const leaf = forge.pki.createCertificate()
        leaf.publicKey = root.publicKey
        leaf.serialNumber = '012345'
        leaf.validity.notBefore = new Date(Date.now() - 60000)
        leaf.validity.notAfter = new Date(Date.now() + 60000)
        leaf.setSubject([{ name: 'commonName', value: 'localhost' }])
        leaf.setIssuer(root.subject.attributes)
        leaf.setExtensions([
            { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }
        ])
        leaf.sign(key, forge.md.sha256.create())
        const upstream = https.createServer(
            {
                key: keyPEM,
                cert: forge.pki.certificateToPem(leaf),
                ca: forge.pki.certificateToPem(root),
                requestCert: true,
                rejectUnauthorized: true
            },
            (_req, res) => {
                res.setHeader('content-type', 'application/json')
                res.end('{"tls":"decrypted"}')
            }
        )
        upstream.listen(0, '127.0.0.1')
        await once(upstream, 'listening')
        const tlsPort = (upstream.address() as net.AddressInfo).port
        await engine.stop()
        engine = new ProxyEngine(
            store,
            () => {},
            new https.Agent({ ca: await readFile(engine.certificatePath) })
        )
        engine.customCertificates = new CustomCertificates(
            store,
            (v) => Buffer.from(v).toString('base64'),
            (v) => Buffer.from(v, 'base64').toString()
        )
        engine.customCertificates.import(
            { name: 'Upstream mTLS', kind: 'client', host: 'localhost' },
            [Buffer.from(forge.pki.certificateToPem(leaf)), Buffer.from(keyPEM)],
            false
        )
        await engine.start()
        const socket = net.connect(port, '127.0.0.1')
        await once(socket, 'connect')
        socket.write(`CONNECT localhost:${tlsPort} HTTP/1.1\r\nHost: localhost:${tlsPort}\r\n\r\n`)
        await once(socket, 'data')
        const secure = tls.connect({
            socket,
            servername: 'localhost',
            ca: await readFile(engine.certificatePath)
        })
        try {
            await once(secure, 'secureConnect')
            const response = new Promise<string>((resolve, reject) => {
                const chunks: Buffer[] = []
                secure.on('data', (b) => chunks.push(b))
                secure.on('end', () => resolve(Buffer.concat(chunks).toString()))
                secure.on('error', reject)
            })
            secure.write(
                `GET /secure HTTP/1.1\r\nHost: localhost:${tlsPort}\r\nConnection: close\r\n\r\n`
            )
            expect(await response).toContain('{"tls":"decrypted"}')
            const t = [...engine.transactions.values()].find((t) => t.path === '/secure')!
            expect(t.protocol).toBe('HTTPS')
            expect(t.ssl).toBe(true)
            expect(t.responseBody).toBe('{"tls":"decrypted"}')
            store.rules = [rule('breakpoint')]
            const child = spawn(process.execPath, [
                join(process.cwd(), 'tests/fixtures/proxy-tls-client.mjs'),
                String(port),
                String(tlsPort),
                engine.certificatePath
            ])
            child.stdout.resume()
            let stderr = ''
            child.stderr.on('data', (chunk) => {
                stderr += chunk
            })
            const exit = once(child, 'exit')
            try {
                await Promise.race([
                    waitFor(() =>
                        [...engine.transactions.values()].some((t) => t.state === 'paused')
                    ),
                    exit.then(([code]) => {
                        throw new Error(`TLS client exited before breakpoint (${code}): ${stderr}`)
                    })
                ])
                const paused = [...engine.transactions.values()].find((t) => t.state === 'paused')!
                expect(paused.clientPID).toBe(child.pid)
                expect(paused.clientSource).toBe('process')
                expect(() =>
                    engine.resolveBreakpoint(paused.id, 'continue', {
                        url: 'https://example.com/',
                        method: 'GET',
                        headers: {},
                        body: ''
                    })
                ).toThrow('TLS authority')
                engine.resolveBreakpoint(paused.id, 'continue', {
                    url: `https://localhost:${tlsPort}/edited%2Fpath?q=%26`,
                    method: 'GET',
                    headers: {},
                    body: ''
                })
                expect((await exit)[0], stderr).toBe(0)
                expect(paused.path).toBe('/edited%2Fpath?q=%26')
            } finally {
                if (child.exitCode === null && child.signalCode === null) child.kill()
                await exit
            }
        } finally {
            secure.destroy()
            upstream.closeAllConnections()
            await new Promise<void>((r) => upstream.close(() => r()))
        }
    })
    it('uses an imported root issuer for real TLS handshakes and CA export paths', async () => {
        await engine.stop()
        const rootPath = await ensureCertificate(join(directory, 'alternate-ca'))
        const root = await readFile(rootPath)
        const key = await readFile(join(directory, 'alternate-ca/keys/ca.private.key'))
        engine.customCertificates = new CustomCertificates(
            store,
            (v) => Buffer.from(v).toString('base64'),
            (v) => Buffer.from(v, 'base64').toString()
        )
        engine.customCertificates.import(
            { name: 'Alternate CA', kind: 'root', host: '' },
            [root, key],
            false
        )
        await engine.start()
        expect(await readFile(engine.certificatePath, 'utf8')).toBe(root.toString().trim())
        const socket = net.connect(port, '127.0.0.1')
        await once(socket, 'connect')
        socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n')
        await once(socket, 'data')
        const secure = tls.connect({ socket, servername: 'example.com', ca: root })
        try {
            await once(secure, 'secureConnect')
            expect(secure.authorized).toBe(true)
            expect(secure.getPeerCertificate().subject.CN).toBe('example.com')
        } finally {
            secure.destroy()
        }
    })
    it('captures WebSocket messages in both directions', async () => {
        const wss = new WebSocketServer({ server: origin })
        wss.on('connection', (ws) => ws.on('message', (b) => ws.send(b.toString())))
        const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`, {
            headers: { host: `127.0.0.1:${originPort}` }
        })
        await once(ws, 'open')
        ws.send('hello frames')
        const [message] = await once(ws, 'message')
        expect(message.toString()).toBe('hello frames')
        await waitFor(() => [...engine.transactions.values()].some((t) => t.frames.length === 2))
        const t = [...engine.transactions.values()].find((t) => t.protocol === 'WebSocket')!
        expect(t.frames.map((f) => f.direction)).toEqual(['send', 'receive'])
        ws.close()
        await once(ws, 'close')
        wss.close()
    })
    it('bounds captured WebSocket payloads per direction while forwarding later frames', async () => {
        store.settings.maxRequestBodyBytes = 4
        store.settings.maxResponseBodyBytes = 7
        const wss = new WebSocketServer({ server: origin })
        wss.on('connection', (socket) =>
            socket.on('message', (data) => socket.send(data.toString()))
        )
        const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`, {
            headers: { host: `127.0.0.1:${originPort}` }
        })
        try {
            await once(ws, 'open')
            for (const payload of ['abcdefghijk', 'still forwarded']) {
                const received = once(ws, 'message')
                ws.send(payload)
                expect((await received)[0].toString()).toBe(payload)
            }
            await waitFor(() =>
                [...engine.transactions.values()].some((t) => t.responseBytes === 26)
            )
            const t = [...engine.transactions.values()].find((t) => t.protocol === 'WebSocket')!
            expect(
                t.frames
                    .filter((frame) => frame.direction === 'send')
                    .map((frame) => frame.body)
                    .join('')
            ).toBe('abcd')
            expect(
                t.frames
                    .filter((frame) => frame.direction === 'receive')
                    .map((frame) => frame.body)
                    .join('')
            ).toBe('abcdefg')
            expect(t.truncated).toBe(true)
        } finally {
            ws.close()
            await once(ws, 'close')
            wss.close()
        }
    })
    it('delays WebSocket upstream connection and shapes ordered frames in both directions', async () => {
        store.rules = [
            rule('networkCondition', {
                networkPreset: 'custom',
                delay: 120,
                uploadKbps: 64,
                downloadKbps: 64
            })
        ]
        const wss = new WebSocketServer({ server: origin })
        wss.on('connection', (socket) => socket.on('message', (data) => socket.send(data)))
        const started = Date.now()
        const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`, {
            headers: { host: `127.0.0.1:${originPort}` }
        })
        try {
            const connected = once(wss, 'connection')
            await once(ws, 'open')
            await connected
            expect(Date.now() - started).toBeGreaterThanOrEqual(110)
            const messages: Buffer[] = []
            ws.on('message', (data) => messages.push(Buffer.from(data as Buffer)))
            const sent = Date.now()
            ws.send(Buffer.alloc(1024, 1))
            ws.send(Buffer.alloc(1024, 2))
            await waitFor(() => messages.length === 2)
            expect(Date.now() - sent).toBeGreaterThanOrEqual(350)
            expect(messages).toEqual([Buffer.alloc(1024, 1), Buffer.alloc(1024, 2)])
        } finally {
            ws.close()
            await once(ws, 'close')
            wss.close()
        }
    })
    it('routes through an upstream proxy and respects bypass hosts', async () => {
        const routed: http.IncomingMessage[] = []
        const upstream = http.createServer((req, res) => {
            routed.push(req)
            res.end('upstream result')
        })
        upstream.listen(0, '127.0.0.1')
        await once(upstream, 'listening')
        store.settings.upstream = {
            enabled: true,
            url: `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`,
            bypass: []
        }
        try {
            expect((await request()).body).toBe('upstream result')
            expect(routed).toHaveLength(1)
            expect(hits).toHaveLength(0)
            store.settings.upstream.bypass = ['127.0.0.1']
            expect((await request()).body).toContain('/hello')
            expect(routed).toHaveLength(1)
        } finally {
            upstream.closeAllConnections()
            await new Promise<void>((r) => upstream.close(() => r()))
        }
    })
    it('preserves the original request when a script fails', async () => {
        store.scripts = [
            {
                id: randomUUID(),
                name: 'Failure',
                enabled: true,
                pattern: '*',
                phase: 'request',
                code: 'throw new Error()'
            }
        ]
        engine.scriptRunner = async () => {
            throw new Error('Intentional script error')
        }
        expect((await request('/original', 'unchanged', 'POST')).status).toBe(200)
        expect(hits[0].body).toBe('unchanged')
        expect(engine.logs.some((l) => l.message.includes('original traffic preserved'))).toBe(true)
    })
    it('rewrites complete request and compressed response bodies with scripts', async () => {
        store.scripts = [
            {
                id: randomUUID(),
                name: 'Request',
                enabled: true,
                pattern: '*',
                phase: 'request',
                code: ''
            },
            {
                id: randomUUID(),
                name: 'Response',
                enabled: true,
                pattern: '*',
                phase: 'response',
                code: ''
            }
        ]
        engine.scriptRunner = async (script, message) => ({
            ...message,
            body: script.phase === 'request' ? 'rewritten' : '{"scripted":true}'
        })
        const result = await request('/gzip', 'original', 'POST')
        expect(hits[0].body).toBe('rewritten')
        expect(result.body).toBe('{"scripted":true}')
        expect(result.headers['content-encoding']).toBeUndefined()
    })
    it('keeps saved favorites through live-traffic clearing', async () => {
        await request()
        const t = [...engine.transactions.values()][0]
        t.pinned = true
        store.updateFavorite(t)
        engine.clear()
        const restored = new Store(directory)
        restored.loadFavorites()
        expect(restored.favorites.get(t.id)?.pinned).toBe(true)
        expect(engine.transactions.size).toBe(0)
    })
    it('saves and reloads traffic through the persistent session store', async () => {
        await request()
        // Client EOF can arrive before the capture completion event over IPC.
        await waitFor(() => [...engine.transactions.values()][0]?.state === 'completed')
        store.saveSession('Regression', [...engine.transactions.values()])
        const session = store.sessions()[0]
        expect(session.name).toBe('Regression')
        expect(store.loadSession(session.id)[0].responseBody).toContain('/hello')
        store.deleteSession(session.id)
        expect(store.sessions()).toHaveLength(0)
    })
})
async function waitFor(predicate: () => boolean) {
    const start = Date.now()
    while (!predicate()) {
        const timeout = process.platform === 'win32' ? 45000 : 5000
        if (Date.now() - start > timeout) throw new Error('Timed out')
        await new Promise((r) => setTimeout(r, 10))
    }
}
