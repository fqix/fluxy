import { rm } from 'node:fs/promises'
import { ownedProxyPids } from '../tun/proxy-discovery'
import { prepareProxyCore } from './sing-box-proxy'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { Duplex, PassThrough, Readable, Transform, type Writable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Transaction } from '../../shared/contracts/model'
import { StreamChannel } from './proxy-stream'
import { ProxyWire } from './proxy-wire'

export interface InspectorControl {
    stream: Duplex
    ready(): Promise<void>
    close(): Promise<void>
}

type RequestTiming = NonNullable<Transaction['timings']>
type Done = (error?: Error | null) => void
type Hook = (context: IContext, done: Done) => void
type DataHook = (
    context: IContext,
    data: Buffer,
    done: (error: Error | null, data: Buffer) => void
) => void
export interface IContext {
    isSSL: boolean
    onTimings?: (timings: Partial<RequestTiming>) => void
    connectRequest?: http.IncomingMessage
    clientToProxyRequest: http.IncomingMessage
    proxyToClientResponse: http.ServerResponse
    proxyToServerRequest?: http.ClientRequest
    serverToProxyResponse?: http.IncomingMessage
    proxyToServerRequestOptions: {
        method: string
        path: string
        host: string
        port: string | number
        headers: http.IncomingHttpHeaders
        agent: http.Agent
    }
    addRequestFilter(filter: Transform): void
    addResponseFilter(filter: Transform): void
    onRequestData(hook: DataHook): void
    onResponseData(hook: DataHook): void
    onRequestEnd(hook: Hook): void
    onResponseEnd(hook: Hook): void
    onResponse(hook: Hook): void
}
interface WebSocketContext {
    isSSL: boolean
    connectRequest?: http.IncomingMessage
    clientToProxyWebSocket?: EventEmitter
    proxyToServerWebSocket?: { terminate(): void }
    proxyToServerWebSocketOptions?: Omit<https.RequestOptions, 'headers'> & {
        url: string
        headers?: http.IncomingHttpHeaders
    }
    onWebSocketFrame(
        hook: (
            ctx: WebSocketContext,
            type: string,
            fromServer: boolean,
            data: Buffer,
            flags: { binary: boolean },
            done: (error: Error | null, data: Buffer, flags?: { binary: boolean }) => void
        ) => void
    ): void
    onWebSocketClose(
        hook: (ctx: WebSocketContext, code: number, message: string, done: Done) => void
    ): void
    onWebSocketError(hook: (ctx: WebSocketContext, error: Error) => void): void
}
type State = {
    context: IContext
    socket: Duplex
    requestFilters: Transform[]
    responseFilters: Transform[]
    requestData?: DataHook
    responseData?: DataHook
    requestEnd?: Hook
    responseEnd?: Hook
    response?: Hook
    received?: number
    phase?: 'request' | 'response'
    local?: boolean
}
const call = (hook: Hook | undefined, context: IContext) =>
    new Promise<void>((resolve, reject) => {
        if (!hook) return resolve()
        hook(context, (error) => (error ? reject(error) : resolve()))
    })

/** sing-box owns transport and inspection; Fluxy owns policy and sessions. */
export class Proxy {
    port = 0
    httpServer?: EventEmitter
    httpAgent!: http.Agent
    httpsAgent!: http.Agent
    private child?: ChildProcess
    private control?: InspectorControl
    private input?: Writable
    private directory?: string
    private stopping?: Promise<void>
    private wire?: ProxyWire
    private channel?: StreamChannel
    private states = new Map<string, State>()
    private tunnels = new Map<string, Duplex>()
    private websockets = new Map<
        string,
        {
            context: WebSocketContext
            frame?: Parameters<WebSocketContext['onWebSocketFrame']>[0]
            close?: Parameters<WebSocketContext['onWebSocketClose']>[0]
            error?: Parameters<WebSocketContext['onWebSocketError']>[0]
        }
    >()
    private request?: Hook
    private websocket?: (context: WebSocketContext, done: Done) => void
    private connect?: (req: http.IncomingMessage, socket: Duplex, head: Buffer, done: Done) => void
    private errors: ((context: IContext | null, error?: Error, kind?: string) => void)[] = []
    constructor(
        private options: {
            certificate: (host: string) => Promise<{ certificate: string; key: string } | undefined>
            root: () => { certificate: string; key: string } | undefined
            route: (url: string) => string
            inspectQUIC?: (host: string) => boolean
        }
    ) {}
    onRequest(hook: Hook) {
        this.request = hook
    }
    onConnect(hook: NonNullable<Proxy['connect']>) {
        this.connect = hook
    }
    onWebSocketConnection(hook: NonNullable<Proxy['websocket']>) {
        this.websocket = hook
    }
    onError(hook: Proxy['errors'][number]) {
        this.errors.push(hook)
    }
    private send(message: Record<string, unknown>) {
        if (this.input?.writable && !this.input.destroyed) this.wire?.send(message)
    }
    private fail(id: string, error: unknown) {
        const value = error instanceof Error ? error : new Error(String(error))
        const state = this.states.get(id)
        const ws = this.websockets.get(id)
        if (ws) ws.error?.(ws.context, value)
        this.errors.forEach((hook) => hook(state?.context ?? null, value, 'GOPROXY_ERROR'))
        this.send({ type: 'abort', id })
        state?.socket.destroy()
        this.states.delete(id)
        this.channel?.cancel(`${id}:`)
    }
    private socket(id: string, metadata: any): Duplex {
        const socket = new PassThrough()
        Object.assign(socket, metadata, {
            setTimeout() {
                return socket
            },
            timeout: 0
        })
        socket.once('close', () => this.send({ type: 'abort', id }))
        this.httpServer?.emit('connection', socket)
        return socket
    }
    private async output(id: string, phase: 'request' | 'response', state: State) {
        const context = state.context
        let source: Readable =
            phase === 'request' ? context.clientToProxyRequest : context.serverToProxyResponse!
        const original = source as http.IncomingMessage
        for (const filter of phase === 'request' ? state.requestFilters : state.responseFilters)
            source = source.pipe(filter)
        const dataHook = phase === 'request' ? state.requestData : state.responseData
        const endHook = phase === 'request' ? state.requestEnd : state.responseEnd
        const capture = new Transform({
            transform(chunk: Buffer, _encoding, done) {
                if (dataHook) dataHook(context, chunk, done)
                else done(null, chunk)
            },
            flush(done) {
                if (phase === 'response' && state.received)
                    context.onTimings?.({ receive: Date.now() - state.received })
                void call(endHook, context).then(() => done(), done)
            }
        })
        source.on('error', (error) => capture.destroy(error))
        const output = source.pipe(capture)
        Object.defineProperty(output, 'trailers', { get: () => original.trailers })
        await this.channel!.pipe(`${id}:${phase}:out`, output)
    }
    private async message(message: any) {
        const { id, type } = message
        if (message.stream) return this.channel?.receive(message)
        if (type === 'certificate') {
            try {
                this.send({
                    type: 'certificate-result',
                    id,
                    identity: await this.options.certificate(message.host)
                })
            } catch (error) {
                this.send({ type: 'certificate-result', id, error: String(error) })
            }
            return
        }
        if (type === 'quic') {
            this.send({
                type: 'quic-result',
                id,
                inspect: this.options.inspectQUIC?.(message.host) ?? false,
                route: this.options.route(
                    `https://${net.isIP(message.host) === 6 ? `[${message.host}]` : message.host}/`
                )
            })
            return
        }
        if (type === 'connect') {
            const socket = Duplex.from({
                readable: this.channel!.reader(`${id}:tunnel:in`),
                writable: this.channel!.writer(`${id}:tunnel:out`)
            })
            Object.assign(socket, message.socket, {
                setTimeout() {
                    return socket
                },
                timeout: 0
            })
            this.tunnels.set(id, socket)
            socket.on('error', () => {})
            const req = Object.assign(new Readable({ read() {} }), message.request, {
                socket
            }) as http.IncomingMessage
            this.connect?.(req, socket, Buffer.from(message.head ?? []), (error) => {
                this.send({ type: 'inspect', id, error: error?.message })
            })
            return
        }
        if (type === 'request') {
            const socket = this.socket(id, message.socket)
            const source = Object.assign(
                this.channel!.reader(`${id}:request:in`),
                message.request,
                { socket }
            ) as http.IncomingMessage
            const target = new URL(source.url!)
            const response = new PassThrough() as unknown as http.ServerResponse
            let status = 200,
                responseHeaders: http.OutgoingHttpHeaders = {},
                started = false
            response.writeHead = ((code: number, values: http.OutgoingHttpHeaders) => {
                status = code
                responseHeaders = values
                return response
            }) as typeof response.writeHead
            const originalEnd = response.end.bind(response)
            response.end = ((...args: any[]) => {
                if (!started) {
                    started = true
                    state.local = true
                    const phase = state.phase ?? 'request'
                    this.send({
                        type: `${phase}-result`,
                        id,
                        local: true,
                        status,
                        headers: responseHeaders
                    })
                    void this.channel!.pipe(
                        `${id}:${phase}:out`,
                        response as unknown as Readable
                    ).catch((error) => this.fail(id, error))
                }
                return (originalEnd as Function)(...args)
            }) as typeof response.end
            const state = { socket, requestFilters: [], responseFilters: [] } as unknown as State
            const context: IContext = {
                isSSL: target.protocol === 'https:',
                clientToProxyRequest: source,
                proxyToClientResponse: response,
                proxyToServerRequestOptions: {
                    host: target.hostname,
                    port: target.port || (target.protocol === 'https:' ? 443 : 80),
                    path: target.pathname + target.search,
                    method: source.method ?? 'GET',
                    headers: { ...source.headers },
                    agent: target.protocol === 'https:' ? this.httpsAgent! : this.httpAgent!
                },
                addRequestFilter: (filter) => state.requestFilters.push(filter),
                addResponseFilter: (filter) => state.responseFilters.push(filter),
                onRequestData: (hook) => {
                    state.requestData = hook
                },
                onResponseData: (hook) => {
                    state.responseData = hook
                },
                onRequestEnd: (hook) => {
                    state.requestEnd = hook
                },
                onResponseEnd: (hook) => {
                    state.responseEnd = hook
                },
                onResponse: (hook) => {
                    state.response = hook
                }
            }
            state.context = context
            this.states.set(id, state)
            await call(this.request, context)
            if (started) return
            const { agent: _agent, ...options } = context.proxyToServerRequestOptions
            const url = `${context.isSSL ? 'https' : 'http'}://${options.host}:${options.port}${options.path}`
            this.send({ type: 'request-result', id, options, url, route: this.options.route(url) })
            await this.output(id, 'request', state)
        } else if (type === 'response') {
            const state = this.states.get(id)
            if (!state) return this.send({ type: 'abort', id })
            state.phase = 'response'
            state.received = Date.now()
            state.context.serverToProxyResponse = Object.assign(
                this.channel!.reader(`${id}:response:in`),
                message.response,
                { socket: state.socket }
            ) as http.IncomingMessage
            state.context.onTimings?.(message.timings ?? {})
            await call(state.response, state.context)
            if (state.local) return
            const response = state.context.serverToProxyResponse
            this.send({
                type: 'response-result',
                id,
                status: response.statusCode,
                statusMessage: response.statusMessage,
                headers: response.headers,
                rawHeaders: response.rawHeaders
            })
            await this.output(id, 'response', state)
        } else if (type === 'closed') {
            this.tunnels.get(id)?.destroy()
            this.tunnels.delete(id)
            const state = this.states.get(id)
            if (message.aborted && state)
                this.errors.forEach((hook) =>
                    hook(state.context, new Error('Client disconnected'), 'GOPROXY_ABORT')
                )
            state?.socket.destroy()
            this.channel?.cancel(`${id}:`)
            this.states.delete(id)
            const ws = this.websockets.get(id)
            if (ws) {
                ws.context.clientToProxyWebSocket?.emit('close')
                ws.close?.(ws.context, 1000, '', () => {})
                this.websockets.delete(id)
            }
        } else if (type === 'failure') this.fail(id, new Error(message.error))
        else if (type === 'websocket') {
            const client = new EventEmitter()
            const socket = this.socket(id, message.socket)
            const state = {} as NonNullable<ReturnType<typeof this.websockets.get>>
            const context: WebSocketContext = {
                isSSL: message.url.startsWith('wss:'),
                connectRequest: { socket } as http.IncomingMessage,
                clientToProxyWebSocket: client,
                proxyToServerWebSocket: { terminate: () => this.send({ type: 'abort', id }) },
                proxyToServerWebSocketOptions: { url: message.url, headers: message.headers },
                onWebSocketFrame: (hook) => {
                    state.frame = hook
                },
                onWebSocketClose: (hook) => {
                    state.close = hook
                },
                onWebSocketError: (hook) => {
                    state.error = hook
                }
            }
            state.context = context
            this.websockets.set(id, state)
            this.websocket?.(context, (error) =>
                this.send({
                    type: 'websocket-result',
                    id,
                    error: error?.message,
                    options: context.proxyToServerWebSocketOptions,
                    route: this.options.route(message.url)
                })
            )
        } else if (type === 'frame') {
            const state = this.websockets.get(message.session ?? id)
            if (!state) return
            state.frame?.(
                state.context,
                'message',
                message.fromServer,
                Buffer.from(message.data),
                { binary: message.binary },
                (error, data, flags) =>
                    this.send({
                        type: 'frame-result',
                        id: message.frameId,
                        error: error?.message,
                        data,
                        binary: flags?.binary
                    })
            )
        }
    }
    async listen(
        options: {
            port: number
            host: string
            sslCaDir: string
            httpAgent: http.Agent
            httpsAgent: http.Agent
            keepAlive: boolean
            timeout: number
            corePath: string
            directory: string
            openControl?: () => Promise<InspectorControl>
        },
        done: Done
    ) {
        this.httpAgent = options.httpAgent
        this.httpsAgent = options.httpsAgent
        this.httpServer = new EventEmitter()
        const root = this.options.root() ?? {
            certificate: readFileSync(join(options.sslCaDir, 'certs/ca.pem'), 'utf8'),
            key: readFileSync(join(options.sslCaDir, 'keys/ca.private.key'), 'utf8')
        }
        let child: ChildProcess | undefined
        if (options.openControl) {
            this.control = await options.openControl()
        } else {
            const prepared = await prepareProxyCore(
                options.corePath,
                options.directory,
                options.host,
                options.port
            )
            this.directory = prepared.directory
            child = this.child = spawn(options.corePath, ['run', '-c', prepared.config], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
                env: {
                    ...process.env,
                    FLUXY_HELPER_STDIN: '1',
                    FLUXY_HELPER_PARENT: String(process.pid)
                }
            })
            if (child.pid) ownedProxyPids.add(child.pid)
            const owned = child
            child.once('exit', () => {
                if (owned.pid) ownedProxyPids.delete(owned.pid)
            })
        }
        const control = this.control
        const input = (this.input = control?.stream ?? child!.stdin!)
        const output = control?.stream ?? child!.stdout!
        this.wire = new ProxyWire(input)
        this.channel = new StreamChannel((message) => this.send(message))
        let settled = false,
            inspectorReady = false,
            coreReady = false,
            log = ''
        const finish = (error?: Error) => {
            if (!settled) {
                settled = true
                clearTimeout(timer)
                done(error)
            }
        }
        const fatal = (error: Error) => {
            finish(error)
            if (this.input === input && coreReady && inspectorReady)
                this.errors.forEach((hook) => hook(null, error, 'INSPECTOR_EXIT'))
            void this.close().catch(() => {})
        }
        const timer = setTimeout(
            () => {
                fatal(new Error(`sing-box inspector startup timed out: ${log}`))
            },
            control ? 30000 : 15000
        )
        output.on('data', (data) => {
            try {
                this.wire?.receive(data)
            } catch (error) {
                fatal(error instanceof Error ? error : new Error(String(error)))
            }
        })
        child?.stderr?.on('data', (data) => {
            log = (log + data).slice(-8000)
            if (log.includes('sing-box started (')) coreReady = true
            if (coreReady && inspectorReady) finish()
        })
        child?.on('error', fatal)
        input.on('error', fatal)
        const onExit = (code: number | null) => {
            const error = new Error(`sing-box inspector exited (${code}): ${log}`)
            finish(error)
            if (this.input === input)
                this.errors.forEach((hook) => hook(null, error, 'INSPECTOR_EXIT'))
            for (const id of this.states.keys())
                this.fail(id, new Error('sing-box inspector stopped'))
            this.channel?.close()
        }
        child?.on('exit', onExit)
        control?.stream.on('close', () => onExit(null))
        this.wire.on('message', (message: any) => {
            if (message.type === 'ready') {
                this.port = message.port
                inspectorReady = true
                if (control) {
                    void control
                        .ready()
                        .then(() => {
                            if (this.input !== input) return
                            coreReady = true
                            finish()
                        })
                        .catch(fatal)
                } else if (coreReady) finish()
            } else void this.message(message).catch((error) => this.fail(message.id, error))
        })
        control?.stream.resume()
        this.send({
            type: 'start',
            port: options.port,
            host: options.host,
            ingressPort: options.port,
            root
        })
    }
    close(): Promise<void> {
        return (this.stopping ??= this.closeTransport())
    }
    private async closeTransport() {
        const child = this.child
        const exited =
            child?.pid && child.exitCode === null && child.signalCode === null
                ? new Promise<void>((resolve) => child.once('exit', () => resolve()))
                : Promise.resolve()
        this.channel?.close()
        this.child = undefined
        this.input = undefined
        const control = this.control
        this.control = undefined
        control?.stream.destroy()
        child?.stdin?.end()
        child?.kill()
        const force = setTimeout(() => child?.kill('SIGKILL'), 2000)
        force.unref()
        for (const state of this.states.values()) state.socket.destroy()
        this.states.clear()
        this.websockets.clear()
        for (const socket of this.tunnels.values()) socket.destroy()
        this.tunnels.clear()
        await exited
        clearTimeout(force)
        await control?.close()
        if (this.directory) await rm(this.directory, { recursive: true, force: true })
        this.directory = undefined
    }
}
