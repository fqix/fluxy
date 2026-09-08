import { createRequire } from 'node:module'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import https from 'node:https'
import { enableMixedProxy } from './mixed-proxy'
import { onFragmentedMessage, sendFragmentedMessage } from './websocket-fragments'
import { observeTimings } from '../../src/main/capture/timing'
import { StreamChannel } from '../../src/main/capture/whistle-ipc'

// This file is bundled into child.cjs. Whistle and its global patches never load
// in Electron's main process. All policy travels over private, inherited IPC.
const runtime = process.env.FLUXY_WHISTLE_RUNTIME!
const requireRuntime = createRequire(join(runtime, 'package.json'))
const startWhistle = requireRuntime('./upstream')
const config = requireRuntime('./upstream/lib/config')
const util = requireRuntime('./upstream/lib/util')

const { WebSocket, WebSocketServer } = requireRuntime('ws')
const { ProxyAgent } = requireRuntime('proxy-agent')
const send = (message: Record<string, unknown>) => {
    if (process.connected) process.send!(message)
}
const channel = new StreamChannel(send)
const pending = new Map<string, (value: any) => void>()
const active = new Map<string, () => void>()
function ask(type: string, id: string, values: object = {}) {
    return new Promise<any>((resolve) => {
        pending.set(`${type}-result:${id}`, resolve)
        send({ type, id, ...values })
    })
}
const metadata = (req: any) => ({
    remoteAddress: req.clientIp || req.socket.remoteAddress,
    remotePort: req.clientPort || req.socket.remotePort,
    localAddress: req.socket.localAddress,
    localPort: config.port
})
const identity = (source: any) => ({
    headers: source.headers,
    rawHeaders: source.rawHeaders || [],
    method: source.method,
    url: source.fullUrl || source.url,
    statusCode: source.statusCode,
    statusMessage: source.statusMessage,
    httpVersion: source.isH2 ? '2.0' : source.httpVersion,
    trailers: source.trailers
})
function fail(id: string, error: unknown) {
    if (!active.has(id)) return
    send({ type: 'failure', id, error: String(error) })
    active.get(id)?.()
    active.delete(id)
}
function route(req: any, url: string) {
    if (!url) return
    const parsed = new URL(url)
    const protocol = parsed.protocol.startsWith('socks')
        ? 'socks'
        : parsed.protocol === 'https:'
          ? 'https-proxy'
          : 'proxy'
    const Rules = requireRuntime('./upstream/lib/rules/rules')
    const rules = new Rules()
    rules.parse(`* ${protocol}://${parsed.host}${parsed.username ? ' enable://proxyFirst' : ''}`)
    req.headerRulesMgr = rules
    const resolved = rules.resolveReqRules(req)
    Object.assign(req.rules, resolved)
    if (parsed.username)
        req._pacAuth = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
}
function middleware(req: any, res: any, next: () => void) {
    const id = randomUUID()
    req._fluxyStart = Date.now()
    const output = channel.reader(`${id}:request:out`)
    let finished = false
    let upstreamResponse: any
    const close = () => {
        if (finished) return
        finished = true
        active.delete(id)
        output.destroy()
        upstreamResponse?.destroy()
        req._clientReq?.destroy()
        channel.cancel(`${id}:`)
        send({ type: 'closed', id, aborted: !res.writableFinished })
    }
    active.set(id, () => {
        req.destroy()
        res.destroy()
        close()
    })
    res.once('close', close)
    req.once('error', (error: Error) => fail(id, error))
    const requestResult = ask('request', id, { request: identity(req), socket: metadata(req) })
    void channel.pipe(`${id}:request:in`, req).catch((error) => fail(id, error))
    void requestResult
        .then((result) => {
            if (finished) return
            if (result.local) {
                res.writeHead(result.status, result.headers)
                output.pipe(res)
                return
            }
            const options = result.options
            req.headers = options.headers
            req.method = options.method
            req.options = util.parseUrl(result.url)
            req.fullUrl = result.url
            req._fluxyTls = { cert: options.cert, key: options.key, ca: options.ca }
            req.enable.http2 = true
            if (
                result.url.startsWith('http:') &&
                (/^application\/grpc/i.test(req.headers['content-type'] || '') || req.isH2)
            )
                req.enable.httpH2 = true
            req.disable.auto2http = true
            route(req, result.route)
            // Fluxy has already applied byte-preserving edits and stream filters.
            req.pipe = output.pipe.bind(output)
            req.noReqBody = false
            const respond = res.response.bind(res)
            res.response = async (upstream: any) => {
                upstreamResponse = upstream
                await Promise.resolve()
                const body = channel.reader(`${id}:response:out`)
                const responseResult = ask('response', id, {
                    response: identity(upstream),
                    timings: req._fluxyTiming?.timings
                })
                void channel.pipe(`${id}:response:in`, upstream).catch((error) => fail(id, error))
                void responseResult
                    .then((result) => {
                        if (finished) {
                            body.destroy()
                            return
                        }
                        if (result.local) {
                            res.writeHead(result.status, result.headers)
                            body.pipe(res)
                            return
                        }
                        const response = Object.assign(body, {
                            statusCode: result.status,
                            statusMessage: result.statusMessage,
                            headers: result.headers,
                            rawHeaders: result.rawHeaders || [],
                            httpVersion: '1.1'
                        })
                        respond(response)
                    })
                    .catch((error) => fail(id, error))
            }
            next()
        })
        .catch((error) => fail(id, error))
}
function sockets(proxy: any) {
    const server = proxy.server
    const connectHandlers = server.listeners('connect')
    server.removeAllListeners('connect')
    server.on('connect', (req: any, socket: any, head: Buffer) => {
        const id = randomUUID()
        const incoming = channel.reader(`${id}:tunnel:out`)
        let tunneling = false
        incoming.on('data', (data: Buffer) => {
            if (!tunneling) {
                tunneling = true
                void channel.pipe(`${id}:tunnel:in`, socket).catch((error) => fail(id, error))
            }
            if (!socket.write(data))
                (incoming.pause(), socket.once('drain', () => incoming.resume()))
        })
        incoming.once('end', () => socket.end())
        active.set(id, () => socket.destroy())
        socket.once('close', () => {
            active.delete(id)
            incoming.destroy()
            send({ type: 'closed', id })
        })
        pending.set(`inspect:${id}`, (message) => {
            incoming.destroy()
            if (message.error) return socket.destroy()
            for (const handler of connectHandlers) handler.call(server, req, socket, head)
        })
        send({ type: 'connect', id, socket: metadata(req), request: identity(req), head })
    })
    server.removeAllListeners('upgrade')
    const wsServer = new WebSocketServer({ noServer: true, perMessageDeflate: false })
    server.on('upgrade', (req: any, socket: any, head: Buffer) => {
        const id = randomUUID()
        req.isHttps = !!(socket.isHttps || req.isHttps || req.headers[config.HTTPS_FIELD])
        const clientInfo = req.headers[config.CLIENT_INFO_HEADER]?.split(',')
        if (clientInfo) {
            req.clientIp = clientInfo[0]
            req.clientPort = Number(clientInfo[1])
        }
        delete req.headers[config.HTTPS_FIELD]
        delete req.headers[config.CLIENT_INFO_HEADER]
        const url = util.getFullUrl(req).replace(/^http/, 'ws')
        active.set(id, () => socket.destroy())
        void ask('websocket', id, { url, headers: req.headers, socket: metadata(req) })
            .then((result) => {
                if (result.error) throw new Error(result.error)
                const headers = { ...req.headers }
                for (const name of [
                    'connection',
                    'upgrade',
                    'sec-websocket-key',
                    'sec-websocket-version',
                    'sec-websocket-extensions',
                    'sec-websocket-protocol'
                ])
                    delete headers[name]
                const agent = new ProxyAgent({
                    getProxyForUrl: () => result.route || '',
                    httpsAgent: new https.Agent({
                        ca: result.options.ca,
                        cert: result.options.cert,
                        key: result.options.key
                    })
                })
                const upstream = new WebSocket(
                    url,
                    req.headers['sec-websocket-protocol']?.split(/,\s*/),
                    { ...result.options, headers, agent, perMessageDeflate: false }
                )
                const stop = () => {
                    upstream.terminate()
                    socket.destroy()
                    agent.destroy()
                }
                active.set(id, stop)
                socket.once('close', () => {
                    active.delete(id)
                    upstream.terminate()
                    agent.destroy()
                    send({ type: 'closed', id })
                })
                upstream.once('error', (error: Error) => fail(id, error))
                upstream.once('open', () => {
                    wsServer.handleUpgrade(req, socket, head || Buffer.alloc(0), (client: any) => {
                        const transfer = (from: any, to: any, fromServer: boolean) => {
                            let queue = Promise.resolve()
                            onFragmentedMessage(from, (data, binary, lengths) => {
                                from.pause()
                                queue = queue
                                    .then(async () => {
                                        const frameId = randomUUID()
                                        const result = await ask('frame', frameId, {
                                            session: id,
                                            frameId,
                                            fromServer,
                                            data,
                                            binary
                                        })
                                        if (result.error) throw new Error(result.error)
                                        await sendFragmentedMessage(
                                            to,
                                            result.data,
                                            result.binary,
                                            lengths
                                        )
                                        from.resume()
                                    })
                                    .catch((error) => fail(id, error))
                            })
                            from.once('close', (code: number, reason: Buffer) => {
                                if (to.readyState === WebSocket.OPEN)
                                    to.close(code === 1005 || code === 1006 ? 1000 : code, reason)
                            })
                            from.once('error', (error: Error) => fail(id, error))
                        }
                        transfer(client, upstream, false)
                        transfer(upstream, client, true)
                    })
                })
            })
            .catch((error) => fail(id, error))
    })
}
process.on('message', (message: any) => {
    if (message.stream) return channel.receive(message)
    if (message.type === 'abort') {
        active.get(message.id)?.()
        channel.cancel(`${message.id}:`)
        return
    }
    const key = `${message.type}:${message.id}`
    const resolve = pending.get(key)
    if (resolve) {
        pending.delete(key)
        resolve(message)
        return
    }
    if (message.type !== 'start') return
    startWhistle(
        {
            port: message.port,
            host: message.host,
            certDir: message.certDir,
            mode: 'pureProxy|safe|disableUpdateTips',
            shadowRulesOnly: true,
            disableAllPlugins: true,
            noGlobalPlugins: true,
            shadowRules: '* enable://https|http2\n* disable://auto2http',
            middlewares: [middleware]
        },
        (proxy: any) => {
            config.fluxyClient = (req: any, client: any) => {
                const timing = (req._fluxyTiming = { timestamp: req._fluxyStart })
                observeTimings(client, timing)
            }
            config.fluxyCertificate = async (host: string) => {
                const result = await ask('certificate', randomUUID(), { host })
                if (result.error) throw new Error(result.error)
                return (
                    result.identity && {
                        key: result.identity.key,
                        cert: result.identity.certificate
                    }
                )
            }
            sockets(proxy)
            enableMixedProxy(
                proxy.server,
                requireRuntime('sockx'),
                message.port,
                config.CLIENT_INFO_HEADER
            )
            send({ type: 'ready' })
        }
    )
})
process.on('disconnect', () => process.exit(0))
