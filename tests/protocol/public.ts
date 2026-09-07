import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import * as grpc from '@grpc/grpc-js'
import protobuf from 'protobufjs'
import WebSocket from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { startProxy, type Capture } from './engine.js'

const targets = {
    http: process.env.HTTPBIN_HTTP_URL || 'http://httpbingo.org',
    https: process.env.HTTPBIN_HTTPS_URL || 'https://httpbingo.org',
    grpc: process.env.GRPCBIN_TARGET || 'grpcb.in:9000',
    grpcs: process.env.GRPCBIN_TLS_TARGET || 'grpcb.in:9001'
}
const proxy = await startProxy('', [targets.grpc])
const proxyUrl = `http://127.0.0.1:${proxy.port}`
const watchdog = setTimeout(() => {
    console.error('Protocol suite timed out')
    process.exit(1)
}, 180000)
watchdog.unref()
const results: {
    name: string
    outcome: 'passed' | 'failed' | 'upstream-unavailable'
    directError?: string
    proxyError?: string
}[] = []
const root = await protobuf.load(
    fileURLToPath(new URL('../fixtures/har/grpcbin.proto', import.meta.url))
)
const dummy = root.lookupType('grpcbin.DummyMessage')
const errorType = root.lookupType('grpcbin.SpecificErrorRequest')
type Message = { fString: string }
const serialize = (message: Message) => Buffer.from(dummy.encode(message).finish())
const deserialize = (bytes: Buffer) => dummy.toObject(dummy.decode(bytes)) as Message
const deadline = (milliseconds = 8000) => ({ deadline: Date.now() + milliseconds })
const bytes = (encoded: string) => Buffer.from(encoded, 'base64')
async function until<T>(
    read: () => T | Promise<T>,
    predicate: (value: T) => boolean,
    label: string
) {
    const end = Date.now() + 4000
    do {
        const value = await read()
        if (predicate(value)) return value
        await delay(25)
    } while (Date.now() < end)
    throw new Error(`${label}: timeout`)
}
async function observed(path: string, predicate: (value: Capture) => boolean, old: Set<string>) {
    const values = await until(
        () => proxy.snapshot(),
        (items) =>
            items.some((item) => item.url.includes(path) && !old.has(item.id) && predicate(item)),
        `capture ${path}`
    )
    return values.find((item) => item.url.includes(path) && !old.has(item.id) && predicate(item))!
}
function payloads(encoded: string) {
    const data = bytes(encoded),
        values: string[] = []
    for (let offset = 0; offset + 5 <= data.length;) {
        const size = data.readUInt32BE(offset + 1)
        if (offset + size + 5 > data.length) break
        assert.equal(data[offset], 0)
        values.push(deserialize(data.subarray(offset + 5, offset + 5 + size)).fString)
        offset += size + 5
    }
    return values
}
async function attempt(run: () => Promise<void>) {
    try {
        await run()
        return undefined
    } catch (error) {
        return error instanceof Error ? error.message : String(error)
    }
}
async function pair(name: string, run: (proxied: boolean, old: Set<string>) => Promise<void>) {
    const directError = await attempt(() => run(false, new Set()))
    const old = new Set((await proxy.snapshot()).map((item) => item.id))
    const proxyError = await attempt(() => run(true, old))
    const outcome = directError ? 'upstream-unavailable' : proxyError ? 'failed' : 'passed'
    results.push({ name, outcome, directError, proxyError })
    console.log(
        `${outcome.toUpperCase()} ${name}${directError ? `; direct: ${directError}` : ''}${proxyError ? `; proxy: ${proxyError}` : ''}`
    )
    return outcome
}
function request(url: URL, proxied: boolean) {
    const secure = url.protocol === 'https:'
    const agent = proxied && secure ? new HttpsProxyAgent(proxyUrl) : undefined
    const req = (secure ? https : http).get(secure || !proxied ? url : new URL(proxyUrl), {
        ...(proxied && secure ? { agent, ca: proxy.ca } : {}),
        ...(!secure && proxied ? { path: url.href, headers: { host: url.host } } : {}),
        headers: {
            host: url.host,
            'user-agent': 'Fluxy-Protocol-Test/0.1.0',
            'accept-encoding': 'identity'
        }
    })
    const timer = setTimeout(() => req.destroy(new Error('HTTP deadline exceeded')), 10000)
    req.on('error', () => {})
    const response = once(req, 'response').then(([res]) => res as http.IncomingMessage)
    return {
        response,
        close: () => {
            clearTimeout(timer)
            req.destroy()
            agent?.destroy()
        }
    }
}
function client(target: string, secure: boolean, proxied: boolean) {
    return new grpc.Client(
        proxied ? `127.0.0.1:${proxy.port}` : target,
        secure
            ? grpc.credentials.createSsl(proxied ? Buffer.from(proxy.ca) : undefined)
            : grpc.credentials.createInsecure(),
        {
            'grpc.enable_http_proxy': 0,
            'grpc.default_authority': target,
            'grpc.ssl_target_name_override': target.split(':')[0],
            ...(proxied ? { 'grpc.http_connect_target': `dns:${target}` } : {})
        }
    )
}
const statusOf = (
    call:
        | grpc.ClientUnaryCall
        | grpc.ClientReadableStream<Message>
        | grpc.ClientWritableStream<Message>
) => new Promise<grpc.StatusObject>((resolve) => call.once('status', resolve))

try {
    for (const [scheme, base] of [
        ['HTTP', targets.http],
        ['HTTPS', targets.https]
    ] as const) {
        await pair(`go-httpbin ${scheme}: response and capture`, async (proxied, old) => {
            const url = new URL('/anything/fluxy-protocol-test?case=echo', base)
            const test = request(url, proxied)
            try {
                const res = await test.response
                assert.equal(res.statusCode, 200)
                const chunks: Buffer[] = []
                for await (const chunk of res) chunks.push(Buffer.from(chunk))
                const data = JSON.parse(Buffer.concat(chunks).toString())
                assert.deepEqual(data.args.case, ['echo'])
                if (proxied)
                    await observed(
                        '/anything/fluxy-protocol-test',
                        (item) =>
                            item.complete && bytes(item.response).includes(Buffer.from('echo')),
                        old
                    )
            } finally {
                test.close()
            }
        })
        await pair(`go-httpbin ${scheme}: SSE real-time capture`, async (proxied, old) => {
            const test = request(new URL('/sse?count=3&duration=2s&delay=0', base), proxied)
            try {
                const res = await test.response
                assert.equal(res.statusCode, 200)
                assert.match(String(res.headers['content-type']), /text\/event-stream/)
                const chunks: Buffer[] = []
                const ended = once(res, 'end')
                ended.catch(() => {})
                res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
                await until(
                    () => Buffer.concat(chunks).toString(),
                    (text) => text.includes('data:'),
                    'SSE first event'
                )
                assert.equal(res.readableEnded, false, 'First event must precede EOF')
                if (proxied)
                    await observed(
                        '/sse?',
                        (item) =>
                            !item.complete &&
                            (
                                bytes(item.response).toString() +
                                item.frames.map((frame) => bytes(frame.data).toString()).join('')
                            ).includes('data:'),
                        old
                    )
                await ended
                const text = Buffer.concat(chunks).toString()
                assert.equal((text.match(/^data:/gm) || []).length, 3)
            } finally {
                test.close()
            }
        })
        await pair(
            `go-httpbin ${scheme === 'HTTPS' ? 'WSS' : 'WS'}: text, binary and captured frames`,
            async (proxied, old) => {
                const url = new URL('/websocket/echo', base)
                url.protocol = scheme === 'HTTPS' ? 'wss:' : 'ws:'
                const agent = proxied ? new HttpsProxyAgent(proxyUrl) : undefined
                const socket = new WebSocket(url, {
                    agent,
                    ...(proxied ? { ca: proxy.ca } : {}),
                    handshakeTimeout: 8000
                })
                socket.on('error', () => {})
                const timer = setTimeout(() => {
                    socket.emit('error', new Error('WebSocket timeout'))
                    socket.terminate()
                }, 10000)
                try {
                    await once(socket, 'open')
                    for (const [body, binary] of [
                        [Buffer.from('fluxy-protocol-test'), false],
                        [Buffer.from([0, 255, 7]), true]
                    ] as const) {
                        const reply = once(socket, 'message')
                        socket.send(body, { binary })
                        const [data, isBinary] = await reply
                        assert.deepEqual(Buffer.from(data), body)
                        assert.equal(isBinary, binary)
                    }
                    if (proxied)
                        await observed(
                            '/websocket/echo',
                            (item) =>
                                item.frames.filter(
                                    (frame) => frame.opcode === 1 || frame.opcode === 2
                                ).length >= 4,
                            old
                        )
                } finally {
                    clearTimeout(timer)
                    socket.terminate()
                    agent?.destroy()
                }
            }
        )
    }
    for (const [target, secure] of [
        [targets.grpc, false],
        [targets.grpcs, true]
    ] as const) {
        const protocol = secure ? 'gRPCS' : 'gRPC h2c'
        for (const method of [
            'DummyUnary',
            'DummyServerStream',
            'DummyClientStream',
            'DummyBidirectionalStreamStream',
            'SpecificError',
            'CancelBidi'
        ] as const) {
            await pair(`grpcbin ${protocol}: ${method}`, async (proxied, old) => {
                const connection = client(target, secure, proxied)
                let call:
                    | grpc.ClientUnaryCall
                    | grpc.ClientReadableStream<Message>
                    | grpc.ClientWritableStream<Message>
                    | undefined
                const text = `fluxy-${method}`
                const path = `/grpcbin.GRPCBin/${method === 'CancelBidi' ? 'DummyBidirectionalStreamStream' : method}`
                try {
                    if (method === 'DummyUnary' || method === 'SpecificError') {
                        const response = new Promise<Message>((resolve, reject) => {
                            call =
                                method === 'SpecificError'
                                    ? connection.makeUnaryRequest(
                                          path,
                                          (value: { code: number; reason: string }) =>
                                              Buffer.from(errorType.encode(value).finish()),
                                          deserialize,
                                          { code: 3, reason: 'fluxy-protocol-test-invalid' },
                                          deadline(),
                                          (error, value) =>
                                              error ? reject(error) : resolve(value!)
                                      )
                                    : connection.makeUnaryRequest(
                                          path,
                                          serialize,
                                          deserialize,
                                          { fString: text },
                                          deadline(),
                                          (error, value) =>
                                              error ? reject(error) : resolve(value!)
                                      )
                        })
                        const status = statusOf(call!)
                        if (method === 'SpecificError') {
                            await assert.rejects(
                                response,
                                (error: unknown) =>
                                    (error as grpc.ServiceError).code ===
                                    grpc.status.INVALID_ARGUMENT
                            )
                            assert.equal((await status).code, 3)
                        } else {
                            assert.equal((await response).fString, text)
                            assert.equal((await status).code, 0)
                            if (proxied)
                                await observed(
                                    path,
                                    (item) =>
                                        item.complete &&
                                        payloads(item.response).includes(text) &&
                                        item.trailers?.['grpc-status'] === '0',
                                    old
                                )
                        }
                    } else if (method === 'DummyClientStream') {
                        const response = new Promise<Message>((resolve, reject) => {
                            call = connection.makeClientStreamRequest(
                                path,
                                serialize,
                                deserialize,
                                deadline(),
                                (error, value) => (error ? reject(error) : resolve(value!))
                            )
                        })
                        response.catch(() => {})
                        const writable = call as grpc.ClientWritableStream<Message>
                        const status = statusOf(writable)
                        writable.write({ fString: `${text}-0` })
                        if (proxied)
                            await observed(
                                path,
                                (item) =>
                                    !item.complete && payloads(item.request).includes(`${text}-0`),
                                old
                            )
                        for (let i = 1; i < 10; i++) writable.write({ fString: `${text}-${i}` })
                        writable.end()
                        assert.equal((await response).fString, `${text}-9`)
                        assert.equal((await status).code, 0)
                        if (proxied)
                            await observed(
                                path,
                                (item) =>
                                    item.complete &&
                                    payloads(item.request).length === 10 &&
                                    payloads(item.response).includes(`${text}-9`),
                                old
                            )
                    } else {
                        const stream =
                            method === 'DummyServerStream'
                                ? connection.makeServerStreamRequest(
                                      path,
                                      serialize,
                                      deserialize,
                                      { fString: text },
                                      deadline(25000)
                                  )
                                : connection.makeBidiStreamRequest(
                                      path,
                                      serialize,
                                      deserialize,
                                      deadline()
                                  )
                        call = stream
                        const values: string[] = []
                        let error: Error | undefined
                        stream.on('data', (message: Message) => values.push(message.fString))
                        stream.on('error', (value: Error) => {
                            error = value
                        })
                        const status = statusOf(stream)
                        if (method !== 'DummyServerStream')
                            (stream as grpc.ClientDuplexStream<Message, Message>).write({
                                fString: `${text}-first`
                            })
                        await until(
                            () => {
                                if (error) throw error
                                return values
                            },
                            (items) => items.length > 0,
                            'gRPC first streaming reply'
                        )
                        if (method === 'DummyServerStream') {
                            assert.equal((await status).code, 0)
                            assert.deepEqual(values, Array(10).fill(text))
                            if (proxied)
                                await observed(
                                    path,
                                    (item) =>
                                        item.complete && payloads(item.response).length === 10,
                                    old
                                )
                        } else {
                            assert.equal(
                                stream.readableEnded,
                                false,
                                'Bidirectional response before upload ends'
                            )
                            if (proxied)
                                await observed(
                                    path,
                                    (item) =>
                                        !item.complete &&
                                        payloads(item.response).includes(`${text}-first`),
                                    old
                                )
                            if (method === 'CancelBidi') {
                                stream.cancel()
                                assert.equal((await status).code, grpc.status.CANCELLED)
                            } else {
                                ;(stream as grpc.ClientDuplexStream<Message, Message>).end({
                                    fString: `${text}-second`
                                })
                                assert.equal((await status).code, 0)
                                assert.deepEqual(values, [`${text}-first`, `${text}-second`])
                                if (proxied)
                                    await observed(
                                        path,
                                        (item) =>
                                            item.complete && payloads(item.response).length === 2,
                                        old
                                    )
                            }
                        }
                    }
                } finally {
                    call?.cancel()
                    connection.close()
                }
            })
        }
    }
} finally {
    await mkdir(new URL('../../test-results/protocol/', import.meta.url), { recursive: true })
    await writeFile(
        new URL('../../test-results/protocol/whistle-public.json', import.meta.url),
        JSON.stringify(
            {
                generatedAt: new Date().toISOString(),
                engine: 'whistle',
                version: '2.10.9',
                node: process.version,
                platform: process.platform,
                arch: process.arch,
                targets,
                results,
                proxyLog: proxy.logs()
            },
            null,
            2
        ) + '\n'
    )
    await proxy.stop()
    console.log(
        `\n${results.filter((result) => result.outcome === 'passed').length}/${results.length} public checks passed. See test-results/protocol/whistle-public.json`
    )
    process.exitCode = results.some((result) => result.outcome !== 'passed') ? 1 : 0
}
