import { observeTimings } from './timing'
import {
    activeNetworkCondition,
    networkRates,
    networkTransform,
    NetworkPacer,
    waitNetwork
} from './network-conditions'
import { matchesBreakpoint } from '../rules/rule-match'
import { ProcessResolver } from './process-resolver'
import type { CustomCertificates } from '../certificates/custom-certificates'
import { Proxy, type IContext, type InspectorControl } from './inspector-transport'
import { bundledCorePath } from './sing-box-proxy'
import http from 'node:http'
import { isUtf8 } from 'node:buffer'
import https from 'node:https'
import net from 'node:net'
import { Readable, type Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
    brotliDecompressSync,
    gunzipSync,
    inflateRawSync,
    inflateSync,
    zstdDecompressSync
} from 'node:zlib'
import { ensureCertificate } from '../certificates/certificates'
import { Store } from '../storage/store'
import { upstreamAgent } from './upstream'
import { openTunnel } from '../tun/tun-bridge'
import {
    breakpointEditSchema,
    MAX_CAPTURE_BODY_BYTES,
    matchPattern,
    matchesRule,
    type BreakpointEdit,
    type Transaction,
    type Headers,
    type LogEntry,
    type AppEvent,
    type ComposeRequest,
    type Script,
    type ScriptMessage
} from '../../shared/contracts/model'

// Script/breakpoint processing has a fixed safety ceiling independent of previews.
const BODY_LIMIT = MAX_CAPTURE_BODY_BYTES
const headers = (input: http.IncomingHttpHeaders): Headers =>
    Object.fromEntries(
        Object.entries(input)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join('\n') : String(v)])
    )
export function decode(buffer: Buffer, encoding?: string, onLimit?: () => void) {
    try {
        const options = { maxOutputLength: BODY_LIMIT }
        if (encoding === 'gzip') return gunzipSync(buffer, options)
        if (encoding === 'br') return brotliDecompressSync(buffer, options)
        // Chromium has advertised zstd since 123, so origins negotiate it against browsers.
        if (encoding === 'zstd' && typeof zstdDecompressSync === 'function')
            return zstdDecompressSync(buffer, options)
        if (encoding === 'deflate') {
            try {
                return inflateSync(buffer, options)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw error
                // Some origins send bare DEFLATE (RFC 1951) without the zlib wrapper.
                return inflateRawSync(buffer, options)
            }
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') onLimit?.()
        /* A partial compressed body stays available as raw bytes. */
    }
    return buffer
}
function isStreaming(source: http.IncomingMessage) {
    return /^(application\/grpc|text\/event-stream)/i.test(source.headers['content-type'] ?? '')
}
async function bufferMessage(source: http.IncomingMessage) {
    if (isStreaming(source)) return { body: undefined, replay: (_body?: Buffer) => source }

    const chunks: Buffer[] = []
    let size = 0,
        oversized = false
    for await (const chunk of source.iterator({ destroyOnReturn: false })) {
        const bytes = Buffer.from(chunk)
        chunks.push(bytes)
        size += bytes.length
        if (size > BODY_LIMIT) {
            oversized = true
            break
        }
    }
    const replay = (body?: Buffer) =>
        Object.defineProperty(
            Object.assign(
                body
                    ? Readable.from([body])
                    : Readable.from(
                          (async function* () {
                              for (const chunk of chunks) yield chunk
                              if (oversized) for await (const chunk of source) yield chunk
                          })()
                      ),
                {
                    headers: { ...source.headers },
                    rawHeaders: [...(source.rawHeaders ?? [])],
                    method: source.method,
                    url: source.url,
                    socket: source.socket,
                    httpVersion: source.httpVersion,
                    statusCode: source.statusCode,
                    statusMessage: source.statusMessage
                }
            ),
            'trailers',
            { get: () => source.trailers }
        ) as http.IncomingMessage
    return { body: oversized ? undefined : Buffer.concat(chunks), replay }
}
function orderedHeaders(input: http.IncomingHttpHeaders, raw: string[] = []) {
    // Retain wire order/casing where no rule or script changed the header value.
    const original = new Map<string, { name: string; value: string }[]>()
    for (let i = 0; i < raw.length; i += 2) {
        const key = raw[i].toLowerCase(),
            entries = original.get(key) ?? []
        entries.push({ name: raw[i], value: raw[i + 1] })
        original.set(key, entries)
    }
    return Object.entries(input).flatMap(([name, value]) => {
        if (value === undefined) return []
        const entries = original.get(name.toLowerCase())
        const parts = Array.isArray(value) ? value : [String(value)]
        if (
            entries &&
            (entries.map((h) => h.value).join(', ') === parts.join(', ') ||
                entries.map((h) => h.value).join('; ') === parts.join('; '))
        )
            return entries
        return parts.map((value) => ({ name, value }))
    })
}
function editedHeaders(edit: BreakpointEdit, original: http.IncomingHttpHeaders) {
    const clean: http.OutgoingHttpHeaders = Object.create(null)
    for (const { name, value } of edit.headerEntries ??
        Object.entries(edit.headers).map(([name, value]) => ({ name, value }))) {
        const key = name.toLowerCase(),
            previous = clean[key]
        clean[key] =
            previous === undefined
                ? value
                : Array.isArray(previous)
                  ? [...previous, value]
                  : [String(previous), value]
    }
    for (const key of [
        'content-length',
        'transfer-encoding',
        'connection',
        'proxy-authorization',
        'proxy-connection'
    ])
        delete clean[key]
    if (edit.preserveBody) {
        // Framing and encoding describe the original bytes and are not editable in passthrough mode.
        for (const key of ['content-length', 'content-encoding']) {
            delete clean[key]
            if (original[key] !== undefined) clean[key] = original[key]
        }
    } else {
        delete clean['content-encoding']
        clean['content-length'] = String(Buffer.byteLength(edit.body))
    }
    return clean as http.IncomingHttpHeaders
}
function editableBody(body: Buffer | undefined, encoding?: string) {
    if (!body) return undefined
    // Keep compressed bytes intact; raw HTTP edits must not silently change their encoding.
    if (encoding && encoding !== 'identity') return undefined
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
        return /[\x00-\x08\x0e-\x1f]/.test(text) ? undefined : text
    } catch {
        return undefined
    }
}
export class ProxyEngine {
    private processResolver = new ProcessResolver()
    private async identify(t: Transaction, socket: net.Socket) {
        const identity = await this.processResolver.resolve(socket)
        if (identity) {
            Object.assign(t, identity)
            this.publish(t)
        }
    }
    customCertificates?: CustomCertificates
    transactions = new Map<string, Transaction>()
    logs: LogEntry[] = []
    running = false
    recording = true
    get certificatePath() {
        return (
            this.customCertificates?.publicRootPath() ??
            join(this.store.directory, 'certificates', 'certs', 'ca.pem')
        )
    }
    scriptRunner?: (script: Script, message: ScriptMessage) => Promise<ScriptMessage>
    inspectorControl?: () => Promise<InspectorControl>
    private transportEgress?: string
    setTransportEgress(url?: string) {
        if (this.running) throw new Error('Stop capture before changing transport')
        this.transportEgress = url
    }
    private proxy?: Proxy
    onFailure?: (error: Error) => Promise<void>
    private routeAgent: ReturnType<typeof upstreamAgent>
    private starting?: Promise<void>
    private stopping?: Promise<void>
    private sequence = 0
    private sockets = new Set<Duplex>()
    private pending = new Map<
        string,
        (action: 'continue' | 'abort', edit?: BreakpointEdit) => void
    >()
    private context = new WeakMap<object, Transaction>()
    private published = new Set<string>()
    private generation = 0
    private transactionGeneration = new WeakMap<Transaction, number>()
    private deleted = new WeakSet<Transaction>()
    constructor(
        readonly store: Store,
        private emit: (event: AppEvent) => void,
        private upstreamHTTPSAgent?: https.Agent,
        private corePath = bundledCorePath()
    ) {
        this.routeAgent = upstreamAgent(
            () => store.settings,
            upstreamHTTPSAgent,
            () => this.transportEgress
        )
    }
    log(message: string, level: LogEntry['level'] = 'info') {
        const log = { id: randomUUID(), timestamp: Date.now(), level, message }
        this.logs.push(log)
        if (this.logs.length > 2000) this.logs.shift()
        this.emit({ type: 'log', log })
    }
    publish(t: Transaction) {
        if (!this.published.has(t.id)) return
        this.transactions.set(t.id, t)
        this.enforceEntryLimit()
        if (!this.transactions.has(t.id)) return
        this.emit({ type: 'transaction', transaction: { ...t } })
    }
    enforceEntryLimit() {
        while (this.transactions.size > this.store.settings.maxEntries) {
            let id: string | undefined
            for (const transaction of this.transactions.values()) {
                if (transaction.state !== 'paused') {
                    id = transaction.id
                    break
                }
            }
            if (!id) break
            this.transactions.delete(id)
            this.published.delete(id)
        }
    }
    private bodyLimit(phase: 'request' | 'response') {
        return phase === 'request'
            ? this.store.settings.maxRequestBodyBytes
            : this.store.settings.maxResponseBodyBytes
    }
    private captureBody(
        t: Transaction,
        phase: 'request' | 'response',
        input: Buffer,
        encoding?: string
    ) {
        const limit = this.bodyLimit(phase)
        const decoded =
            limit === 0
                ? input
                : decode(input, encoding, () => {
                      t.truncated = true
                  })
        const body = decoded.subarray(0, limit)
        if (decoded.length > limit) t.truncated = true
        const contentType =
            phase === 'request'
                ? t.requestHeaders['content-type']
                : t.responseHeaders['content-type']
        const binary =
            !isUtf8(body) ||
            (phase === 'request'
                ? /protobuf|grpc|octet-stream/.test(contentType ?? '')
                : !/json|text|xml|javascript|form/.test(contentType ?? ''))
        if (phase === 'request') {
            t.requestBody = body.toString('utf8')
            if (binary && body.length) t.requestBase64 = body.toString('base64')
            else delete t.requestBase64
        } else {
            t.responseBody = body.toString('utf8')
            if (binary && body.length) t.responseBase64 = body.toString('base64')
            else delete t.responseBase64
        }
    }
    private bypassed(host: string) {
        return this.store.settings.fullBypassHosts.some((pattern) => matchPattern(pattern, host))
    }
    create(
        urlString: string,
        method: string,
        requestHeaders: Headers,
        client?: string
    ): Transaction {
        const url = new URL(urlString)
        const ua = requestHeaders['user-agent'] ?? ''
        const t: Transaction = {
            id: randomUUID(),
            sequence: ++this.sequence,
            timestamp: Date.now(),
            method,
            url: url.href,
            host: url.hostname,
            path: url.pathname + url.search,
            protocol: url.protocol === 'https:' ? 'HTTPS' : 'HTTP',
            client:
                client ??
                (/curl/i.test(ua)
                    ? 'curl'
                    : /Firefox/.test(ua)
                      ? 'Firefox'
                      : /Chrome/.test(ua)
                        ? 'Google Chrome'
                        : /Safari/.test(ua)
                          ? 'Safari'
                          : /python/i.test(ua)
                            ? 'Python'
                            : 'Unknown'),
            clientSource: client === 'Composer' ? 'composer' : ua ? 'user-agent' : 'unknown',
            state: 'pending',
            requestHeaders,
            responseHeaders: {},
            requestBody: '',
            responseBody: '',
            requestBytes: 0,
            responseBytes: 0,
            duration: 0,
            ssl: url.protocol === 'https:',
            frames: [],
            pinned: false,
            saved: false,
            note: ''
        }
        this.transactionGeneration.set(t, this.generation)
        if ((this.recording && !this.bypassed(url.hostname)) || client === 'Composer')
            this.published.add(t.id)
        this.publish(t)
        return t
    }
    complete(t: Transaction, error?: Error) {
        t.duration = Date.now() - t.timestamp
        if (t.timings) t.timings.total = t.duration
        if (error) {
            t.error = error.message
            t.state = 'error'
        } else if (t.state !== 'blocked') t.state = 'completed'
        this.publish(t)
        if (this.store.favorites.has(t.id)) this.store.updateFavorite(t)
    }
    deleteTransactions(ids: string[]) {
        for (const id of ids) {
            const t = this.transactions.get(id)
            if (t) this.deleted.add(t)
            this.published.delete(id)
            this.pending.get(id)?.('abort')
            this.transactions.delete(id)
        }
        this.emit({ type: 'state' })
    }
    clear() {
        this.transactions.clear()
        this.published.clear()
        this.generation++
        for (const finish of this.pending.values()) finish('abort')
        this.emit({ type: 'state' })
    }
    replace(items: Transaction[]) {
        this.clear()
        for (const t of items.slice(-this.store.settings.maxEntries)) {
            t.sequence = ++this.sequence
            this.transactions.set(t.id, t)
            this.published.add(t.id)
        }
        this.emit({ type: 'state' })
    }
    async start() {
        if (this.stopping) await this.stopping
        if (this.running) return
        if (this.starting) return this.starting
        this.starting = this.listen()
        try {
            await this.starting
        } finally {
            this.starting = undefined
        }
    }
    private async listen() {
        await ensureCertificate(join(this.store.directory, 'certificates'))
        this.routeAgent = upstreamAgent(
            () => this.store.settings,
            this.upstreamHTTPSAgent,
            () => this.transportEgress
        )
        const proxy = new Proxy({
            certificate: async (host) =>
                this.customCertificates?.hasServer(host)
                    ? this.customCertificates.server(host)
                    : undefined,
            root: () => this.customCertificates?.rootIdentity(),
            route: (url) => {
                if (this.transportEgress) return this.transportEgress
                const host = new URL(url).hostname
                const upstream = this.store.settings.upstream
                return !this.bypassed(host) &&
                    upstream.enabled &&
                    !upstream.bypass.some((pattern) => matchPattern(pattern, host))
                    ? upstream.url
                    : ''
            }
        })
        this.proxy = proxy
        proxy.onError((ctx, error, kind) => {
            if (kind === 'INSPECTOR_EXIT' && this.proxy === proxy)
                this.failed(error ?? new Error(kind))
            const t = ctx && this.context.get(ctx)
            if (t) this.complete(t, error ?? new Error(kind))
            this.log(`${kind}: ${error?.message ?? 'Proxy error'}`, 'error')
        })
        proxy.onConnect((req, socket, head, callback) => {
            let target: URL
            try {
                target = new URL(`https://${req.url}`)
            } catch {
                socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
                return
            }
            if (!target.hostname || /[/\\\0]/.test(target.hostname)) {
                socket.destroy()
                return
            }
            if (
                !this.bypassed(target.hostname) &&
                this.store.settings.ssl &&
                this.store.settings.sslHosts.some((pattern) =>
                    matchPattern(pattern, target.hostname)
                )
            ) {
                callback()
                return
            }
            if (
                !this.transportEgress &&
                !this.bypassed(target.hostname) &&
                this.store.settings.upstream.enabled &&
                !this.store.settings.upstream.bypass.some((pattern) =>
                    matchPattern(pattern, target.hostname)
                )
            ) {
                socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
                this.log('Upstream routing requires SSL inspection for CONNECT tunnels', 'warn')
                return
            }
            const t = this.create(target.href, 'CONNECT', headers(req.headers))
            void this.identify(t, socket as net.Socket)
            t.ssl = false
            const attach = (upstream: net.Socket) => {
                this.track(upstream)
                this.track(socket)
                t.status = 200
                t.statusMessage = 'Connection Established'
                this.publish(t)
                socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
                if (head.length) upstream.write(head)
                socket.pipe(upstream)
                upstream.pipe(socket)
                upstream.on('data', (b) => {
                    t.responseBytes += b.length
                })
                socket.on('data', (b) => {
                    t.requestBytes += b.length
                })
                upstream.once('error', (e) => {
                    this.complete(t, e)
                    socket.destroy()
                })
                socket.once('error', () => upstream.destroy())
                socket.once('close', () => {
                    upstream.destroy()
                    if (t.state !== 'error') this.complete(t)
                })
            }
            const host = target.hostname.replace(/^\[|\]$/g, '')
            const port = Number(target.port) || 443
            if (this.transportEgress) {
                void openTunnel(this.transportEgress, host, port)
                    .then(attach)
                    .catch((error) => {
                        this.complete(t, error)
                        socket.destroy()
                    })
            } else {
                const upstream = net.connect(port, host)
                upstream.once('connect', () => attach(upstream))
                upstream.once('error', (error) => {
                    this.complete(t, error)
                    socket.destroy()
                })
            }
        })
        proxy.onRequest((ctx, callback) => {
            void this.handleRequest(ctx, callback).catch((error) => {
                const t = this.context.get(ctx)
                if (t) this.complete(t, error)
                callback(error)
            })
        })
        proxy.onWebSocketConnection((ctx, callback) => {
            const options = ctx.proxyToServerWebSocketOptions
            if (!options?.url) {
                callback(new Error('Missing WebSocket URL'))
                return
            }
            Object.assign(options, this.customCertificates?.client(new URL(options.url).hostname))
            if (this.upstreamHTTPSAgent?.options.ca) options.ca = this.upstreamHTTPSAgent.options.ca
            const t = this.create(options.url, 'GET', headers(options.headers ?? {}))
            const clientSocket =
                ctx.connectRequest?.socket ??
                (ctx.clientToProxyWebSocket as unknown as { _socket?: net.Socket })?._socket
            if (clientSocket) void this.identify(t, clientSocket)
            const condition = activeNetworkCondition(
                this.store.rules,
                'GET',
                options.url,
                t.requestHeaders
            )
            const network = networkRates(condition),
                controller = new AbortController()
            if (condition) t.rule = condition.name
            ctx.clientToProxyWebSocket?.once('close', () => controller.abort())
            const upload = new NetworkPacer(network.uploadKbps, controller.signal),
                download = new NetworkPacer(network.downloadKbps, controller.signal)
            t.protocol = 'WebSocket'
            t.ssl = ctx.isSSL
            t.status = 101
            t.statusMessage = 'Switching Protocols'
            this.context.set(ctx, t)
            this.publish(t)
            let requestFrameBytes = 0,
                responseFrameBytes = 0
            ctx.onWebSocketFrame((_ctx, type, fromServer, data, flags, done) => {
                if (type === 'message') {
                    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
                    const limit = this.bodyLimit(fromServer ? 'response' : 'request')
                    const used = fromServer ? responseFrameBytes : requestFrameBytes
                    const captured = buf.subarray(0, Math.min(65536, Math.max(0, limit - used)))
                    if (captured.length < buf.length) t.truncated = true
                    if (fromServer) responseFrameBytes += captured.length
                    else requestFrameBytes += captured.length
                    if (captured.length || buf.length === 0)
                        t.frames.push({
                            id: randomUUID(),
                            time: Date.now(),
                            direction: fromServer ? 'receive' : 'send',
                            body: captured.toString(flags?.binary ? 'hex' : 'utf8'),
                            binary: !!flags?.binary
                        })
                    if (t.frames.length > 1000) {
                        t.frames.shift()
                        t.truncated = true
                    }
                    if (fromServer) t.responseBytes += buf.length
                    else t.requestBytes += buf.length
                    this.publish(t)
                }
                const size =
                    type === 'message'
                        ? Buffer.isBuffer(data)
                            ? data.length
                            : Buffer.byteLength(String(data))
                        : 0
                void (fromServer ? download : upload).pace(size).then(
                    () => done(null, data, flags),
                    (error) => done(error, data, flags)
                )
            })
            ctx.onWebSocketClose((_ctx, _code, _message, done) => {
                this.complete(t)
                done(null)
            })
            ctx.onWebSocketError((_ctx, error) =>
                this.complete(t, error ?? new Error('WebSocket error'))
            )
            ctx.clientToProxyWebSocket?.once('close', () => ctx.proxyToServerWebSocket?.terminate())
            if (condition)
                void waitNetwork(network.delay, controller.signal).then(() => callback(), callback)
            else callback()
        })
        // Preflight gives a clear bind error before the dependency creates its internal servers.
        const host = this.store.settings.localhostOnly ? '127.0.0.1' : '0.0.0.0'
        try {
            await new Promise<void>((resolve, reject) => {
                const probe = net.createServer()
                probe.once('error', reject)
                probe.listen(this.store.settings.port, host, () => probe.close(() => resolve()))
            })
            await new Promise<void>((resolve, reject) => {
                void proxy
                    .listen(
                        {
                            port: this.store.settings.port,
                            host,
                            corePath: this.corePath,
                            directory: this.store.directory,
                            openControl: this.inspectorControl,
                            sslCaDir: join(this.store.directory, 'certificates'),
                            keepAlive: true,
                            httpsAgent: this.routeAgent,
                            httpAgent: this.routeAgent,
                            timeout: 120000
                        },
                        (error) => (error ? reject(error) : resolve())
                    )
                    .catch(reject)
                proxy.onError((_ctx, error, kind) => {
                    if (!this.running && kind === 'HTTP_SERVER_ERROR') reject(error)
                })
            })
            proxy.httpServer?.on('connection', (socket) => this.track(socket))
            this.running = true
            this.log(`Proxy listening on ${host}:${this.store.settings.port}`)
            this.log(
                !this.transportEgress
                    ? `sing-box: HTTP/HTTPS and SOCKS5 share ${host}:${this.store.settings.port}`
                    : `TUN inspection: HTTP/CONNECT on ${host}:${this.store.settings.port}`
            )
            this.emit({ type: 'state' })
        } catch (error) {
            if (proxy.httpServer) await proxy.close()
            this.routeAgent.destroy()
            this.proxy = undefined
            throw error
        }
    }
    private track(socket: Duplex) {
        this.sockets.add(socket)
        socket.once('close', () => this.sockets.delete(socket))
    }
    private async applyScripts(
        source: http.IncomingMessage,
        t: Transaction,
        phase: 'request' | 'response'
    ): Promise<http.IncomingMessage> {
        const scripts = this.store.scripts.filter(
            (s) => s.enabled && s.phase === phase && matchPattern(s.pattern, t.url)
        )
        if (!scripts.length || !this.scriptRunner) return source
        if (isStreaming(source)) {
            this.log(`Skipped body scripts for a streaming ${phase}: ${t.host}`, 'info')
            return source
        }
        if (Number(source.headers['content-length']) > BODY_LIMIT) {
            this.log(`Skipped scripts for a body larger than 2 MB: ${t.host}`, 'warn')
            return source
        }
        const chunks: Buffer[] = []
        let size = 0,
            oversized = false
        for await (const chunk of source.iterator({ destroyOnReturn: false })) {
            const buffer = Buffer.from(chunk)
            chunks.push(buffer)
            size += buffer.length
            if (size > BODY_LIMIT) {
                oversized = true
                break
            }
        }
        const replay = (body?: Buffer) => {
            const data = body
                ? Readable.from([body])
                : Readable.from(
                      (async function* () {
                          for (const chunk of chunks) yield chunk
                          if (oversized) for await (const chunk of source) yield chunk
                      })()
                  )
            return Object.defineProperty(
                Object.assign(data, {
                    headers: { ...source.headers },
                    method: source.method,
                    url: source.url,
                    socket: source.socket,
                    httpVersion: source.httpVersion,
                    statusCode: source.statusCode,
                    statusMessage: source.statusMessage
                }),
                'trailers',
                { get: () => source.trailers }
            ) as http.IncomingMessage
        }
        if (oversized) {
            this.log(`Skipped scripts for a streaming body larger than 2 MB: ${t.host}`, 'warn')
            return replay()
        }
        const original = Buffer.concat(chunks)
        const decoded = decode(original, source.headers['content-encoding'])
        if (source.headers['content-encoding'] && decoded === original) {
            this.log('Script skipped: payload compression could not be decoded', 'warn')
            return replay(original)
        }
        let message: ScriptMessage = {
            url: t.url,
            method: t.method as ComposeRequest['method'],
            headers: headers(source.headers),
            body: decoded.toString('utf8'),
            ...(phase === 'response' ? { status: source.statusCode } : {})
        }
        try {
            for (const script of scripts) message = await this.scriptRunner(script, message)
            const replacement = replay(Buffer.from(message.body))
            replacement.headers = message.headers
            delete replacement.headers['content-encoding']
            delete replacement.headers['transfer-encoding']
            replacement.headers['content-length'] = String(Buffer.byteLength(message.body))
            if (phase === 'request') {
                const target = new URL(message.url)
                if (
                    ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) &&
                    Number(target.port) === this.store.settings.port
                )
                    throw new Error('Script attempted to route to the proxy itself')
                t.url = target.href
                t.host = target.hostname
                t.path = target.pathname + target.search
                t.method = message.method
                replacement.method = message.method
                replacement.url = t.url
                replacement.headers.host = target.host
                t.requestHeaders = headers(replacement.headers)
            } else replacement.statusCode = message.status ?? source.statusCode
            this.log(`Applied ${scripts.length} ${phase} script(s) to ${t.host}`)
            return replacement
        } catch (error) {
            this.log(`Script failed; original traffic preserved: ${String(error)}`, 'error')
            return replay(original)
        }
    }
    private async handleRequest(ctx: IContext, callback: (error?: Error | null) => void) {
        const req = ctx.clientToProxyRequest
        const rawURL = req.url ?? '/'
        const url = /^https?:\/\//.test(rawURL)
            ? rawURL
            : `${ctx.isSSL ? 'https' : 'http'}://${req.headers.host}${rawURL}`
        const parsed = new URL(url)
        if (
            ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) &&
            Number(parsed.port) === this.store.settings.port
        )
            throw new Error('Proxy routing loop detected')
        if (this.bypassed(parsed.hostname)) {
            this.track(req.socket)
            const opts = ctx.proxyToServerRequestOptions!
            Object.assign(opts, this.customCertificates?.client(parsed.hostname))
            delete opts.headers['proxy-authorization']
            delete opts.headers['proxy-connection']
            if (!this.transportEgress)
                opts.agent = ctx.isSSL
                    ? (this.upstreamHTTPSAgent ?? https.globalAgent)
                    : http.globalAgent
            callback()
            return
        }
        const t = this.create(url, req.method ?? 'GET', headers(req.headers))
        t.httpVersion = req.httpVersion
        ctx.onTimings = (timings) => {
            t.timings = { ...t.timings, ...timings }
        }
        await this.identify(t, ctx.connectRequest?.socket ?? req.socket)
        this.context.set(ctx, t)
        this.track(req.socket)
        const opts = ctx.proxyToServerRequestOptions!
        if (ctx.isSSL && this.upstreamHTTPSAgent?.options.ca)
            (opts as https.RequestOptions).ca = this.upstreamHTTPSAgent.options.ca
        delete opts.headers['proxy-authorization']
        delete opts.headers['proxy-connection']
        if (this.store.settings.noCache) {
            delete opts.headers['if-none-match']
            delete opts.headers['if-modified-since']
            opts.headers['cache-control'] = 'no-cache'
        }
        const rules = this.store.rules.filter((r) =>
            r.kind === 'breakpoint'
                ? matchesBreakpoint(r, t.method, t.url, t.requestHeaders)
                : matchesRule(r, t.method, t.url)
        )
        const condition = activeNetworkCondition(
            this.store.rules,
            t.method,
            t.url,
            t.requestHeaders
        )
        const network = networkRates(condition)
        if (condition) {
            t.rule = condition.name
            const controller = new AbortController(),
                close = () => controller.abort()
            req.socket.once('close', close)
            try {
                if (req.socket.destroyed) controller.abort()
                await waitNetwork(network.delay, controller.signal)
            } finally {
                req.socket.removeListener('close', close)
            }
        }
        const allowRules = this.store.rules.filter((r) => r.enabled && r.kind === 'allow')
        const deny =
            allowRules.length > 0 && !allowRules.some((r) => matchesRule(r, t.method, t.url))
        const block = rules.find((r) => r.kind === 'block')
        if (deny || block) {
            t.rule = block?.name ?? 'Allow List'
            t.state = 'blocked'
            this.respond(ctx, t, 403, 'Blocked by Fluxy')
            req.resume()
            return
        }
        const local = rules.find((r) => r.kind === 'mapLocal')
        if (local) {
            t.rule = local.name
            if ((await stat(local.value)).size > 20 * 1024 * 1024)
                throw new Error('Map Local file exceeds 20 MB')
            const body = await readFile(local.value)
            this.respond(ctx, t, local.status, body, local.header || 'application/json')
            req.resume()
            return
        }
        for (const rule of rules) {
            t.rule = rule.name
            if (rule.kind === 'mapRemote') {
                const target = new URL(rule.value)
                if (!['http:', 'https:'].includes(target.protocol))
                    throw new Error('Map Remote requires an HTTP(S) URL')
                if (
                    ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) &&
                    Number(target.port) === this.store.settings.port
                )
                    throw new Error('Map Remote routing loop detected')
                ctx.isSSL = target.protocol === 'https:'
                opts.host = target.hostname
                opts.port = target.port || (ctx.isSSL ? 443 : 80)
                opts.path = target.pathname + target.search
                opts.headers.host = target.host
                opts.agent = ctx.isSSL ? this.proxy!.httpsAgent : this.proxy!.httpAgent
            }
            if (rule.kind === 'requestHeader') {
                if (rule.value) opts.headers[rule.header.toLowerCase()] = rule.value
                else delete opts.headers[rule.header.toLowerCase()]
            }
            if (rule.kind === 'throttle')
                await new Promise((resolve) => setTimeout(resolve, rule.delay))
        }
        if (
            this.store.scripts.some(
                (s) => s.enabled && s.phase === 'request' && matchPattern(s.pattern, t.url)
            )
        )
            ctx.clientToProxyRequest.headers = { ...opts.headers }
        const scripted = await this.applyScripts(ctx.clientToProxyRequest, t, 'request')
        if (scripted !== ctx.clientToProxyRequest) {
            ctx.clientToProxyRequest = scripted
            if (t.url !== url) {
                const target = new URL(t.url)
                ctx.isSSL = target.protocol === 'https:'
                opts.host = target.hostname
                opts.port = target.port || (ctx.isSSL ? 443 : 80)
                opts.path = target.pathname + target.search
                opts.agent = ctx.isSSL ? this.proxy!.httpsAgent : this.proxy!.httpAgent
            }
            opts.method = t.method
            opts.headers = headers(scripted.headers)
        }
        const rate = (key: 'uploadKbps' | 'downloadKbps') =>
            Math.min(
                ...rules.filter((r) => r.kind === 'throttle' && r[key] > 0).map((r) => r[key]),
                network[key] || Infinity
            )
        const upload = rate('uploadKbps'),
            download = rate('downloadKbps')
        if (Number.isFinite(upload)) ctx.addRequestFilter(networkTransform(upload, req.socket))
        if (Number.isFinite(download)) ctx.addResponseFilter(networkTransform(download, req.socket))
        let requestChunks: Buffer[] = [],
            responseChunks: Buffer[] = []
        let requestStored = 0,
            responseStored = 0
        ctx.onRequestData((_ctx, chunk, done) => {
            t.requestBytes += chunk.length
            const limit = this.bodyLimit('request')
            const slice = chunk.subarray(0, Math.max(0, limit - requestStored))
            if (slice.length) requestChunks.push(slice)
            requestStored += slice.length
            if (t.requestBytes > limit) t.truncated = true
            if (t.httpVersion === '2.0') {
                const body = Buffer.concat(requestChunks)
                this.captureBody(t, 'request', body)
                this.publish(t)
            }
            done(null, chunk)
        })
        ctx.onRequestEnd((_ctx, done) => {
            const body = Buffer.concat(requestChunks)
            this.captureBody(t, 'request', body)
            requestChunks = []
            this.publish(t)
            done()
        })
        ctx.onResponse((_ctx, done) => {
            void (async () => {
                let response = ctx.serverToProxyResponse!
                for (const rule of rules.filter((r) => r.kind === 'responseHeader')) {
                    if (rule.value) response.headers[rule.header.toLowerCase()] = rule.value
                    else delete response.headers[rule.header.toLowerCase()]
                }
                if (this.store.settings.noCache) response.headers['cache-control'] = 'no-store'
                response = await this.applyScripts(response, t, 'response')
                if (
                    rules.some(
                        (r) =>
                            r.kind === 'breakpoint' &&
                            (r.phase === 'response' || r.phase === 'both')
                    )
                ) {
                    const buffered = await bufferMessage(response)
                    response = buffered.replay()
                    {
                        t.status = response.statusCode
                        t.responseHeaders = headers(response.headers)
                        t.responseHeaderEntries = orderedHeaders(
                            response.headers,
                            response.rawHeaders
                        )
                        const text = editableBody(
                            buffered.body,
                            t.responseHeaders['content-encoding']
                        )
                        t.breakpointBodyEditable = text !== undefined
                        t.responseBody = text ?? ''
                        if (
                            text !== undefined &&
                            Buffer.byteLength(text) > this.bodyLimit('response')
                        ) {
                            this.captureBody(t, 'response', Buffer.from(text))
                            t.breakpointBodyEditable = false
                        }
                        t.breakpointRuleName = rules.find(
                            (r) => r.kind === 'breakpoint' && r.phase !== 'request'
                        )?.name
                        const { action, edit } = await this.pauseAtBreakpoint(
                            t,
                            'response',
                            req.socket
                        )
                        if (action === 'abort') {
                            this.respond(ctx, t, 503, 'Response aborted at breakpoint')
                            return
                        }
                        if (edit && 'status' in edit) {
                            response = buffered.replay(
                                edit.preserveBody ? undefined : Buffer.from(edit.body)
                            )
                            response.statusCode = edit.status
                            response.statusMessage = http.STATUS_CODES[edit.status]
                            response.headers = editedHeaders(edit, response.headers)
                            response.rawHeaders = []
                        }
                    }
                }
                ctx.serverToProxyResponse = response
                t.status = response.statusCode
                t.statusMessage = response.statusMessage
                t.responseHeaders = headers(response.headers)
                t.responseHeaderEntries = orderedHeaders(response.headers, response.rawHeaders)
                this.publish(t)
                done()
            })().catch((error) => done(error))
        })
        ctx.onResponseData((_ctx, chunk, done) => {
            t.responseBytes += chunk.length
            const limit = this.bodyLimit('response')
            const slice = chunk.subarray(0, Math.max(0, limit - responseStored))
            if (slice.length) responseChunks.push(slice)
            responseStored += slice.length
            if (t.responseBytes > limit) t.truncated = true
            if (
                t.httpVersion === '2.0' ||
                /text\/event-stream/.test(t.responseHeaders['content-type'] ?? '')
            ) {
                const body = Buffer.concat(responseChunks)
                this.captureBody(t, 'response', body)
                this.publish(t)
            }
            done(null, chunk)
        })
        ctx.onResponseEnd((_ctx, done) => {
            const body = Buffer.concat(responseChunks)
            responseChunks = []
            this.captureBody(t, 'response', body, t.responseHeaders['content-encoding'])
            t.responseTrailers = headers(ctx.serverToProxyResponse?.trailers ?? {})
            this.complete(t)
            done()
        })
        if (rules.some((r) => r.kind === 'breakpoint' && r.phase !== 'response')) {
            const buffered = await bufferMessage(ctx.clientToProxyRequest)
            ctx.clientToProxyRequest = buffered.replay()
            {
                const text = editableBody(
                    buffered.body,
                    headers(ctx.clientToProxyRequest.headers)['content-encoding']
                )
                t.breakpointBodyEditable = text !== undefined
                t.requestBody = text ?? ''
                if (text !== undefined && Buffer.byteLength(text) > this.bodyLimit('request')) {
                    this.captureBody(t, 'request', Buffer.from(text))
                    t.breakpointBodyEditable = false
                }
                t.requestHeaders = headers(opts.headers)
                t.requestHeaderEntries = orderedHeaders(opts.headers, req.rawHeaders)
                t.breakpointRuleName = rules.find(
                    (r) => r.kind === 'breakpoint' && r.phase !== 'response'
                )?.name
                const { action, edit } = await this.pauseAtBreakpoint(t, 'request', req.socket)
                if (action === 'abort') {
                    this.respond(ctx, t, 503, 'Request aborted at breakpoint')
                    return
                }
                if (edit && 'url' in edit) {
                    const target = new URL(edit.url)
                    ctx.isSSL = target.protocol === 'https:'
                    opts.host = target.hostname
                    opts.port = target.port || (ctx.isSSL ? 443 : 80)
                    opts.path = target.pathname + target.search
                    opts.method = edit.method
                    opts.headers = {
                        ...editedHeaders(edit, ctx.clientToProxyRequest.headers),
                        host: target.host
                    } as unknown as typeof opts.headers
                    opts.agent = ctx.isSSL ? this.proxy!.httpsAgent : this.proxy!.httpAgent
                    ctx.clientToProxyRequest = buffered.replay(
                        edit.preserveBody ? undefined : Buffer.from(edit.body)
                    )
                    ctx.clientToProxyRequest.headers = { ...opts.headers }
                    t.url = target.href
                    t.ssl = target.protocol === 'https:'
                    t.protocol = t.ssl ? 'HTTPS' : 'HTTP'
                    t.host = target.hostname
                    t.path = target.pathname + target.search
                    t.method = edit.method
                    t.requestHeaders = headers(opts.headers)
                }
            }
        }
        t.requestHeaderEntries = orderedHeaders(opts.headers, ctx.clientToProxyRequest.rawHeaders)
        delete (opts as https.RequestOptions).cert
        delete (opts as https.RequestOptions).key
        Object.assign(opts, this.customCertificates?.client(new URL(t.url).hostname))
        callback()
        if (ctx.proxyToServerRequest) observeTimings(ctx.proxyToServerRequest, t)
    }
    private pauseAtBreakpoint(t: Transaction, phase: 'request' | 'response', socket: Duplex) {
        if (this.deleted.has(t) || this.transactionGeneration.get(t) !== this.generation)
            return Promise.resolve<{ action: 'continue' | 'abort'; edit?: BreakpointEdit }>({
                action: 'continue'
            })
        return new Promise<{ action: 'continue' | 'abort'; edit?: BreakpointEdit }>((resolve) => {
            let finished = false
            const tcp = socket as net.Socket
            const previousTimeout = tcp.timeout ?? 0
            tcp.setTimeout?.(0)
            const finish = (action: 'continue' | 'abort', edit?: BreakpointEdit) => {
                if (finished) return
                finished = true
                tcp.setTimeout?.(previousTimeout)
                socket.removeListener('close', disconnected)
                this.pending.delete(t.id)
                t.breakpointPhase = undefined
                t.state = action === 'abort' ? 'blocked' : 'pending'
                this.publish(t)
                resolve({ action, edit })
            }
            const disconnected = () => finish('abort')
            socket.once('close', disconnected)
            this.pending.set(t.id, finish)
            this.published.add(t.id)
            t.state = 'paused'
            t.breakpointPhase = phase
            this.publish(t)
            if (socket.destroyed) finish('abort')
        })
    }
    private respond(
        ctx: IContext,
        t: Transaction,
        status: number,
        body: string | Buffer,
        contentType = 'text/plain'
    ) {
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body)
        t.status = status
        t.statusMessage = http.STATUS_CODES[status]
        t.responseHeaders = { 'content-type': contentType, 'content-length': String(buffer.length) }
        t.responseHeaderEntries = orderedHeaders(t.responseHeaders)
        this.captureBody(t, 'response', buffer)
        t.responseBytes = buffer.length
        ctx.proxyToClientResponse.writeHead(status, t.responseHeaders)
        ctx.proxyToClientResponse.end(buffer)
        this.complete(t)
    }
    private validateBreakpointEdit(id: string, edit: BreakpointEdit) {
        if (!this.pending.has(id)) throw new Error('Breakpoint has already finished')
        edit = breakpointEditSchema.parse(edit)
        const transaction = this.transactions.get(id)!
        if (transaction.breakpointBodyEditable === false && !edit.preserveBody)
            throw new Error('This body must be preserved unchanged')
        const phase = transaction.breakpointPhase
        if (phase === 'response' && !('status' in edit))
            throw new Error('Use a response edit for this breakpoint')
        if (phase === 'request' && !('url' in edit))
            throw new Error('Use a request edit for this breakpoint')
        if ('url' in edit) {
            const url = new URL(edit.url)
            if (transaction.ssl && url.origin !== new URL(transaction.url).origin)
                throw new Error('HTTPS breakpoints cannot change the TLS authority')
            if (
                ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
                Number(url.port) === this.store.settings.port
            )
                throw new Error('Breakpoint cannot route a request to the proxy itself')
        }
        return edit
    }
    resolveBreakpoint(id: string, action: 'continue' | 'abort', edit?: BreakpointEdit) {
        const handler = this.pending.get(id)
        if (!handler) throw new Error('Breakpoint has already finished')
        handler(
            action,
            edit && action === 'continue' ? this.validateBreakpointEdit(id, edit) : undefined
        )
    }
    applyBreakpoints(edits: { id: string; edit: BreakpointEdit }[]) {
        if (new Set(edits.map((e) => e.id)).size !== edits.length)
            throw new Error('Duplicate breakpoint in batch')
        // Validate the entire selected queue before releasing any request.
        const ready = edits.map(({ id, edit }) => ({
            finish: this.pending.get(id)!,
            edit: this.validateBreakpointEdit(id, edit)
        }))
        for (const { finish, edit } of ready) finish('continue', edit)
    }
    resolveAllBreakpoints(action: 'continue' | 'abort') {
        for (const finish of [...this.pending.values()]) finish(action)
    }
    private failed(error: Error) {
        this.log(error.message, 'error')
        void (this.onFailure ? this.onFailure(error) : this.stop()).catch((failure) =>
            this.log(`Proxy cleanup failed: ${String(failure)}`, 'error')
        )
    }
    stop(): Promise<void> {
        if (this.stopping) return this.stopping
        this.stopping = this.close().finally(() => {
            this.stopping = undefined
        })
        return this.stopping
    }
    private async close() {
        if (this.starting) await this.starting.catch(() => {})
        for (const [id] of this.pending) this.resolveBreakpoint(id, 'abort')
        for (const socket of this.sockets) socket.destroy()
        this.sockets.clear()
        this.proxy?.httpAgent?.destroy()
        this.proxy?.httpsAgent?.destroy()
        if (this.proxy?.httpServer) await this.proxy.close()
        this.proxy = undefined
        this.running = false
        this.log('Proxy stopped')
        this.emit({ type: 'state' })
    }
    async compose(input: ComposeRequest): Promise<Transaction> {
        const url = new URL(input.url)
        if (
            ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
            Number(url.port) === this.store.settings.port
        )
            throw new Error('Cannot send the proxy a request to itself')
        const clean = { ...input.headers }
        delete clean['content-length']
        delete clean['transfer-encoding']
        delete clean['host']
        delete clean['connection']
        const t = this.create(input.url, input.method, clean, 'Composer')
        this.captureBody(t, 'request', Buffer.from(input.body))
        t.requestBytes = Buffer.byteLength(input.body)
        return new Promise<Transaction>((resolve) => {
            const req = (url.protocol === 'https:' ? https : http).request(
                url,
                {
                    ...this.customCertificates?.client(url.hostname),
                    method: input.method,
                    agent: this.routeAgent,
                    headers: {
                        ...clean,
                        ...(input.body
                            ? { 'content-length': String(Buffer.byteLength(input.body)) }
                            : {})
                    },
                    timeout: 30000
                },
                (response) => {
                    t.status = response.statusCode
                    t.statusMessage = response.statusMessage
                    t.responseHeaders = headers(response.headers)
                    let chunks: Buffer[] = [],
                        stored = 0
                    response.on('data', (chunk: Buffer) => {
                        t.responseBytes += chunk.length
                        const limit = this.bodyLimit('response')
                        const part = chunk.subarray(0, Math.max(0, limit - stored))
                        if (part.length) chunks.push(part)
                        stored += part.length
                        if (t.responseBytes > limit) t.truncated = true
                    })
                    response.on('end', () => {
                        const body = Buffer.concat(chunks)
                        chunks = []
                        this.captureBody(t, 'response', body, t.responseHeaders['content-encoding'])
                        this.complete(t)
                        resolve(t)
                    })
                    response.on('error', (error) => {
                        this.complete(t, error)
                        resolve(t)
                    })
                }
            )
            observeTimings(req, t)
            req.on('timeout', () => req.destroy(new Error('Request timed out after 30 seconds')))
            req.on('error', (error) => {
                this.complete(t, error)
                resolve(t)
            })
            req.end(input.body || undefined)
        })
    }
}
