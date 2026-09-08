import { randomUUID } from 'node:crypto'
import { ruleSchema } from '../../src/shared/contracts/model'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import { X509Certificate } from 'node:crypto'
import type { TLSSocket } from 'node:tls'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import * as grpc from '@grpc/grpc-js'
import { HttpsProxyAgent } from 'https-proxy-agent'
import WebSocket from 'ws'
import { startProxy, type Capture } from './engine.js'
import { origins, serialize, deserialize, service, type Payload } from './fixtures.js'

const watchdog = setTimeout(() => {
    console.error('Protocol suite timed out')
    process.exit(1)
}, 180000)
watchdog.unref()
const results: { name: string; passed: boolean; durationMs: number; error?: string }[] = []
const fixture = await origins()
const proxy = await startProxy(fixture.tls.cert, fixture.grpcPort).catch(async (error) => {
    await fixture.stop()
    throw error
})
const proxyUrl = `http://127.0.0.1:${proxy.port}`
const deadline = () => ({ deadline: Date.now() + 5000 })
const decode = (body: string) => Buffer.from(body, 'base64')
function messages(body: string) {
    const bytes = decode(body),
        values: string[] = []
    for (let offset = 0; offset + 5 <= bytes.length;) {
        const length = bytes.readUInt32BE(offset + 1)
        if (offset + 5 + length > bytes.length) break
        assert.equal(bytes[offset], 0, 'Fixture expects uncompressed gRPC messages')
        values.push(deserialize(bytes.subarray(offset + 5, offset + 5 + length)).text)
        offset += length + 5
    }
    return values
}
async function eventually<T>(
    read: () => T | Promise<T>,
    matches: (value: T) => boolean,
    label: string,
    ms = 2000
): Promise<T> {
    const until = Date.now() + ms
    let value: T
    do {
        value = await read()
        if (matches(value)) return value
        await delay(20)
    } while (Date.now() < until)
    throw new Error(`${label}: condition not met within ${ms}ms`)
}
async function check(name: string, run: () => Promise<void>) {
    const start = Date.now()
    try {
        await run()
        results.push({ name, passed: true, durationMs: Date.now() - start })
        console.log(`PASS ${name}`)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        results.push({ name, passed: false, durationMs: Date.now() - start, error: message })
        console.log(`FAIL ${name}: ${message}`)
    }
}
async function capture(
    path: string,
    predicate: (value: Capture) => boolean = () => true,
    exclude = new Set<string>()
) {
    const captures = await eventually(
        () => proxy.snapshot(),
        (values) =>
            values.some(
                (value) => value.url.endsWith(path) && !exclude.has(value.id) && predicate(value)
            ),
        `capture ${path}`
    )
    return captures.find(
        (value) => value.url.endsWith(path) && !exclude.has(value.id) && predicate(value)
    )!
}
function httpRequest(secure: boolean, path: string, body?: Buffer) {
    const port = secure ? fixture.httpsPort : fixture.httpPort
    const url = `${secure ? 'https' : 'http'}://localhost:${port}${path}`
    const agent = secure ? new HttpsProxyAgent(proxyUrl) : undefined
    const options = secure
        ? { agent, ca: proxy.ca }
        : {
              host: '127.0.0.1',
              port: proxy.port,
              path: url,
              headers: { host: `localhost:${port}` }
          }
    const request = (secure ? https : http).request(secure ? url : proxyUrl, {
        ...options,
        method: body ? 'POST' : 'GET'
    })
    request.setTimeout(5000, () => request.destroy(new Error('HTTP timeout')))
    request.on('error', () => {})
    const response = once(request, 'response').then(([value]) => value as http.IncomingMessage)
    request.end(body)
    return {
        request,
        response,
        close: () => {
            request.destroy()
            agent?.destroy()
        }
    }
}

function grpcClient(secure: boolean, direct = false) {
    const port = secure ? fixture.grpcsPort : fixture.grpcPort
    return new grpc.Client(
        direct ? `localhost:${port}` : `127.0.0.1:${proxy.port}`,
        secure
            ? grpc.credentials.createSsl(Buffer.from(direct ? fixture.tls.cert : proxy.ca))
            : grpc.credentials.createInsecure(),
        {
            'grpc.enable_http_proxy': 0,
            'grpc.default_authority': `localhost:${port}`,
            'grpc.ssl_target_name_override': 'localhost',
            ...(direct ? {} : { 'grpc.http_connect_target': `dns:localhost:${port}` })
        }
    )
}
function statusOf(
    call:
        | grpc.ClientUnaryCall
        | grpc.ClientReadableStream<Payload>
        | grpc.ClientWritableStream<Payload>
) {
    return new Promise<grpc.StatusObject>((resolve) => call.once('status', resolve))
}
function unary(client: grpc.Client, text: string, fail = false) {
    let call!: grpc.ClientUnaryCall
    const response = new Promise<Payload>((resolve, reject) => {
        call = client.makeUnaryRequest(
            fail ? service.fail.path : service.unary.path,
            serialize,
            deserialize,
            { text },
            deadline(),
            (error, value) => (error ? reject(error) : resolve(value!))
        )
    })
    return { response, status: statusOf(call), call }
}
async function grpcCapture(path: string, expected: string[], old: Set<string>) {
    const result = await capture(path, (value) => value.complete, old)
    assert.equal(result.useH2, true, 'Capture must identify HTTP/2')
    assert.deepEqual(messages(result.response), expected, 'Captured protobuf responses')
    return result
}
function assertStatus(status: grpc.StatusObject, code = grpc.status.OK) {
    assert.equal(status.code, code)
    assert.deepEqual(status.metadata.get('x-fluxy-trailer'), ['finished'])
}

try {
    for (const secure of [false, true]) {
        const protocol = secure ? 'HTTPS' : 'HTTP'
        await check(`${protocol}: binary POST, capture, TLS verification`, async () => {
            const body = Buffer.from([0, 1, 2, 127, 128, 255])
            const test = httpRequest(secure, `/echo-${protocol}`, body)
            try {
                const res = await test.response
                assert.equal(res.statusCode, 200)
                if (secure) {
                    const socket = res.socket as TLSSocket
                    assert.equal(socket.authorized, true)
                    assert.notEqual(
                        socket.getPeerCertificate().fingerprint256,
                        new X509Certificate(fixture.tls.cert).fingerprint256,
                        'Must intercept TLS, not tunnel it'
                    )
                }
                const chunks: Buffer[] = []
                for await (const chunk of res) chunks.push(Buffer.from(chunk))
                assert.deepEqual(Buffer.concat(chunks), body)
                const captured = await capture(`/echo-${protocol}`, (value) => value.complete)
                assert.deepEqual(decode(captured.request), body)
                assert.deepEqual(decode(captured.response), body)
            } finally {
                test.close()
            }
        })
        await check(
            `${protocol} SSE: first event before EOF, live capture, complete event sequence`,
            async () => {
                const path = `/sse/${protocol}`
                const test = httpRequest(secure, path)
                try {
                    const res = await test.response
                    assert.equal(res.headers['content-type'], 'text/event-stream')
                    const chunks: Buffer[] = []
                    const ended = once(res, 'end')
                    ended.catch(() => {})
                    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
                    await eventually(
                        () => Buffer.concat(chunks).toString(),
                        (text) => text.includes('data: first'),
                        'SSE first event'
                    )
                    assert.equal(res.readableEnded, false)
                    await capture(
                        path,
                        (value) =>
                            !value.complete &&
                            (
                                decode(value.response).toString() +
                                value.frames.map((frame) => decode(frame.data).toString()).join('')
                            ).includes('data: first')
                    )
                    fixture.releases.get(path)!()
                    await ended
                    assert.equal(
                        Buffer.concat(chunks).toString(),
                        'id: 1\ndata: first\n\nid: 2\ndata: second\n\n'
                    )
                } finally {
                    test.close()
                }
            }
        )
        await check(`${protocol} SSE: client cancellation reaches origin`, async () => {
            const path = `/sse/cancel-${protocol}`
            const test = httpRequest(secure, path)
            try {
                const res = await test.response
                await once(res, 'data')
                test.close()
                await eventually(
                    () => fixture.cancelled.has(path),
                    Boolean,
                    'SSE origin cancellation'
                )
            } finally {
                test.close()
            }
        })
        await check(
            `${secure ? 'WSS' : 'WS'}: bidirectional text/binary messages and capture`,
            async () => {
                const path = `/ws-${protocol}`
                const agent = new HttpsProxyAgent(proxyUrl)
                const socket = new WebSocket(
                    `${secure ? 'wss' : 'ws'}://localhost:${secure ? fixture.httpsPort : fixture.httpPort}${path}`,
                    { agent, ca: proxy.ca, handshakeTimeout: 5000 }
                )
                try {
                    await once(socket, 'open')
                    for (const [body, binary] of [
                        [Buffer.from('hello 流'), false],
                        [Buffer.from([0, 255, 123]), true]
                    ] as const) {
                        const message = once(socket, 'message')
                        socket.send(body, { binary })
                        const [received, isBinary] = await message
                        assert.deepEqual(Buffer.from(received), body)
                        assert.equal(isBinary, binary)
                    }
                    const captured = await capture(
                        path,
                        (value) =>
                            value.frames.filter((frame) => frame.opcode === 1 || frame.opcode === 2)
                                .length >= 4
                    )
                    assert.equal(
                        captured.frames.filter((frame) => frame.isClient && frame.opcode === 2)
                            .length,
                        1
                    )
                    assert.equal(
                        captured.frames.filter((frame) => !frame.isClient && frame.opcode === 2)
                            .length,
                        1
                    )
                } finally {
                    socket.terminate()
                    agent.destroy()
                }
            }
        )
    }

    for (const secure of [false, true]) {
        const protocol = secure ? 'gRPCS' : 'gRPC (h2c)'
        await check(`${protocol}: direct origin control`, async () => {
            const client = grpcClient(secure, true)
            try {
                const result = unary(client, 'control')
                assert.deepEqual(await result.response, { text: 'control' })
                assertStatus(await result.status)
                const rejected = unary(client, 'control', true)
                await assert.rejects(
                    rejected.response,
                    (error: unknown) =>
                        (error as grpc.ServiceError).code === grpc.status.INVALID_ARGUMENT
                )
                assertStatus(await rejected.status, grpc.status.INVALID_ARGUMENT)
            } finally {
                client.close()
            }
        })
        for (const kind of [
            'unary',
            'clientStream',
            'serverStream',
            'bidi',
            'fail',
            'cancel'
        ] as const) {
            await check(`${protocol}: ${kind}`, async () => {
                const client = grpcClient(secure)
                const old = new Set((await proxy.snapshot()).map((value) => value.id))
                const key = `${protocol}-${kind}`
                const calls: { cancel(): void }[] = []
                try {
                    if (kind === 'unary' || kind === 'fail') {
                        const result = unary(client, key, kind === 'fail')
                        calls.push(result.call)
                        if (kind === 'fail') {
                            await assert.rejects(
                                result.response,
                                (error: unknown) =>
                                    (error as grpc.ServiceError).code ===
                                    grpc.status.INVALID_ARGUMENT
                            )
                            const status = await result.status
                            assertStatus(status, grpc.status.INVALID_ARGUMENT)
                            assert.equal(status.details, 'fixture rejected')
                            await capture(service.fail.path, (value) => value.complete, old)
                        } else {
                            assert.deepEqual(await result.response, { text: key })
                            assertStatus(await result.status)
                            const captured = await grpcCapture(service.unary.path, [key], old)
                            assert.deepEqual(messages(captured.request), [key])
                            assert.equal(
                                captured.trailers?.['grpc-status'],
                                '0',
                                'Capture gRPC trailers'
                            )
                        }
                    } else if (kind === 'clientStream') {
                        let call!: grpc.ClientWritableStream<Payload>
                        const response = new Promise<Payload>((resolve, reject) => {
                            call = client.makeClientStreamRequest(
                                service.clientStream.path,
                                serialize,
                                deserialize,
                                deadline(),
                                (error, value) => (error ? reject(error) : resolve(value!))
                            )
                        })
                        response.catch(() => {}) // Assertion may fail before awaiting the response.
                        calls.push(call)
                        const status = statusOf(call)
                        call.write({ text: `${key}:first` })
                        await eventually(
                            () => fixture.received.has(`${key}:first`),
                            Boolean,
                            'Upload arrives before client half-close'
                        )
                        await capture(
                            service.clientStream.path,
                            (value) =>
                                messages(value.request).includes(`${key}:first`) && !value.complete,
                            old
                        )
                        call.end({ text: `${key}:second` })
                        assert.deepEqual(await response, { text: `${key}:first,${key}:second` })
                        assertStatus(await status)
                        await grpcCapture(
                            service.clientStream.path,
                            [`${key}:first,${key}:second`],
                            old
                        )
                    } else {
                        const call =
                            kind === 'bidi'
                                ? client.makeBidiStreamRequest(
                                      service.bidi.path,
                                      serialize,
                                      deserialize,
                                      deadline()
                                  )
                                : client.makeServerStreamRequest(
                                      service[kind].path,
                                      serialize,
                                      deserialize,
                                      { text: key },
                                      deadline()
                                  )
                        calls.push(call)
                        const values: string[] = []
                        let callError: Error | undefined
                        call.on('data', (value: Payload) => values.push(value.text))
                        call.on('error', (error: Error) => {
                            callError = error
                        })
                        const status = statusOf(call)
                        if (kind === 'bidi')
                            (call as grpc.ClientDuplexStream<Payload, Payload>).write({
                                text: `${key}:first`
                            })
                        await eventually(
                            () => {
                                if (callError) throw callError
                                return values
                            },
                            (v) => v.length >= 1,
                            'Streaming first response'
                        )
                        const expectedFirst = kind === 'cancel' ? 'started' : `${key}:first`
                        assert.equal(values[0], expectedFirst)
                        assert.equal(call.readableEnded, false)
                        await capture(
                            service[kind].path,
                            (value) =>
                                !value.complete && messages(value.response).includes(expectedFirst),
                            old
                        )
                        if (kind === 'cancel') {
                            call.cancel()
                            assert.equal((await status).code, grpc.status.CANCELLED)
                            await eventually(
                                () => fixture.cancelled.has(key),
                                Boolean,
                                'gRPC cancellation reaches origin'
                            )
                        } else {
                            if (kind === 'bidi')
                                (call as grpc.ClientDuplexStream<Payload, Payload>).end({
                                    text: `${key}:second`
                                })
                            else fixture.releases.get(key)!()
                            assertStatus(await status)
                            assert.deepEqual(values, [`${key}:first`, `${key}:second`])
                            await grpcCapture(service[kind].path, values, old)
                        }
                    }
                } finally {
                    for (const call of calls) call.cancel()
                    client.close()
                }
            })
        }
    }
    for (const secure of [false, true]) {
        await check(
            `${secure ? 'gRPCS' : 'gRPC'}: header breakpoints preserve live bidi streams`,
            async () => {
                const client = grpcClient(secure)
                proxy.engine.store.rules = [
                    ruleSchema.parse({
                        id: randomUUID(),
                        name: 'Streaming headers',
                        enabled: true,
                        kind: 'breakpoint',
                        pattern: `*${service.bidi.path}`,
                        phase: 'both'
                    })
                ]
                const previous = new Set(proxy.engine.transactions.keys())
                const call = client.makeBidiStreamRequest(
                    service.bidi.path,
                    serialize,
                    deserialize,
                    deadline()
                )
                const status = statusOf(call)
                const values: string[] = []
                call.on('data', (value: Payload) => values.push(value.text))
                call.on('error', () => {})
                try {
                    call.write({ text: 'before-half-close' })
                    for (const phase of ['request', 'response'] as const) {
                        const transaction = await eventually(
                            () =>
                                [...proxy.engine.transactions.values()].find(
                                    (t) =>
                                        !previous.has(t.id) &&
                                        new URL(t.url).pathname === service.bidi.path &&
                                        t.state === 'paused' &&
                                        t.breakpointPhase === phase
                                ),
                            Boolean,
                            `${phase} streaming breakpoint`
                        )
                        assert.equal(transaction!.breakpointBodyEditable, false)
                        proxy.engine.resolveBreakpoint(transaction!.id, 'continue')
                    }
                    await eventually(
                        () => values.length,
                        (size) => size === 1,
                        'bidi reply before client half-close'
                    )
                    call.end({ text: 'after-continue' })
                    assertStatus(await status)
                    assert.deepEqual(values, ['before-half-close', 'after-continue'])
                } finally {
                    proxy.engine.store.rules = []
                    call.cancel()
                    client.close()
                }
            }
        )
    }
} finally {
    clearTimeout(watchdog)
    const report = {
        generatedAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        engine: 'goproxy',
        version: '1.9.1',
        passed: results.filter((result) => result.passed).length,
        failed: results.filter((result) => !result.passed).length,
        results,
        captures: await proxy.snapshot(),
        proxyLog: proxy.logs()
    }
    await mkdir(new URL('../../test-results/protocol/', import.meta.url), { recursive: true })
    await writeFile(
        new URL('../../test-results/protocol/goproxy.json', import.meta.url),
        JSON.stringify(report, null, 2) + '\n'
    )
    await proxy.stop()
    await fixture.stop()
    console.log(
        `\n${report.passed}/${results.length} passed; ${report.failed} failed. Report: test-results/protocol/goproxy.json`
    )
    process.exitCode = report.failed ? 1 : 0
}
