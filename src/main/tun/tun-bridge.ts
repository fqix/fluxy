import http from 'node:http'
import net from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'

const LIMIT = 65536
class Reader {
    private buffer: Buffer
    private iterator: AsyncIterator<Buffer>
    constructor(
        private socket: net.Socket,
        head: Buffer = Buffer.alloc(0)
    ) {
        this.buffer = head
        this.iterator = socket.iterator({ destroyOnReturn: false })
    }
    private async more() {
        const chunk = await this.iterator.next()
        if (chunk.done) throw new Error('Connection closed during handshake')
        this.buffer = Buffer.concat([this.buffer, chunk.value])
        if (this.buffer.length > LIMIT * 2) throw new Error('Handshake exceeds limit')
    }
    async take(n: number): Promise<Buffer> {
        if (n > LIMIT) throw new Error('Handshake exceeds limit')
        while (this.buffer.length < n) await this.more()
        const result = this.buffer.subarray(0, n)
        this.buffer = this.buffer.subarray(n)
        return result
    }
    async headers(): Promise<Buffer> {
        while (true) {
            const end = this.buffer.indexOf('\r\n\r\n')
            if (end >= 0) {
                if (end > 8192) throw new Error('CONNECT headers exceed limit')
                return this.take(end + 4)
            }
            if (this.buffer.length > 8192) throw new Error('CONNECT headers exceed limit')
            await this.more()
        }
    }
    async release() {
        await this.iterator.return?.()
        this.socket.pause()
        if (this.buffer.length) this.socket.unshift(this.buffer)
        this.buffer = Buffer.alloc(0)
    }
}
export function clientHelloSNI(hello: Buffer): string | undefined {
    let pos = 4
    const take = (n: number) => {
        if (pos + n > hello.length) throw new Error('Truncated ClientHello')
        const value = hello.subarray(pos, pos + n)
        pos += n
        return value
    }
    if (hello.length < 4 || hello[0] !== 1 || hello.readUIntBE(1, 3) + 4 !== hello.length)
        throw new Error('Invalid ClientHello')
    take(34)
    take(take(1)[0])
    take(take(2).readUInt16BE())
    take(take(1)[0])
    if (pos === hello.length) return
    const extensions = take(take(2).readUInt16BE())
    for (let i = 0; i < extensions.length;) {
        if (i + 4 > extensions.length) throw new Error('Truncated TLS extension')
        const kind = extensions.readUInt16BE(i),
            length = extensions.readUInt16BE(i + 2)
        i += 4
        if (i + length > extensions.length) throw new Error('Truncated TLS extension')
        const data = extensions.subarray(i, i + length)
        i += length
        if (kind !== 0) continue
        if (data.length < 5 || data.readUInt16BE() !== data.length - 2 || data[2] !== 0)
            throw new Error('Invalid TLS server name')
        const count = data.readUInt16BE(3)
        if (!count || 5 + count > data.length) throw new Error('Invalid TLS server name')
        const name = data
            .subarray(5, 5 + count)
            .toString('ascii')
            .toLowerCase()
        if (name.length > 253 || !/^[a-z0-9.-]+$/.test(name))
            throw new Error('Invalid TLS server name')
        return name
    }
}
async function initialPayload(reader: Reader) {
    let wire = await reader.take(1)
    if (wire[0] !== 22) {
        const methods = [
            'GET ',
            'HEAD ',
            'POST ',
            'PUT ',
            'PATCH ',
            'DELETE ',
            'OPTIONS ',
            'TRACE '
        ]
        while (methods.some((method) => method.startsWith(wire.toString('ascii')))) {
            if (methods.includes(wire.toString('ascii'))) return { protocol: 'http', wire }
            wire = Buffer.concat([wire, await reader.take(1)])
        }
        return { protocol: 'raw', wire }
    }
    let handshake = Buffer.alloc(0)
    while (wire.length < LIMIT) {
        const header = Buffer.concat([wire.subarray(-1), await reader.take(4)])
        const size = header.readUInt16BE(3)
        if (header[0] !== 22 || size > 18432 || size + wire.length + 4 > LIMIT)
            throw new Error('Invalid TLS record')
        const payload = await reader.take(size)
        wire = Buffer.concat([wire, header.subarray(1), payload])
        handshake = Buffer.concat([handshake, payload])
        if (handshake.length >= 4) {
            const length = 4 + handshake.readUIntBE(1, 3)
            if (length > LIMIT) throw new Error('ClientHello exceeds limit')
            if (handshake.length >= length)
                return { protocol: 'tls', sni: clientHelloSNI(handshake.subarray(0, length)), wire }
        }
        wire = Buffer.concat([wire, await reader.take(1)])
    }
    throw new Error('ClientHello exceeds limit')
}
export function authority(host: string, port: number) {
    return `${host.includes(':') ? `[${host}]` : host}:${port}`
}
export async function connect(port: number, host = '127.0.0.1'): Promise<net.Socket> {
    const socket = net.connect(port, host)
    socket.setTimeout(10000, () => socket.destroy(new Error('Connection timed out')))
    try {
        await once(socket, 'connect')
        return socket
    } catch (error) {
        socket.destroy()
        throw error
    }
}
export async function openTunnel(proxy: string, host: string, port: number): Promise<net.Socket> {
    const url = new URL(proxy)
    const socket = await connect(Number(url.port), url.hostname)
    try {
        const auth = url.username
            ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}\r\n`
            : ''
        socket.write(
            `CONNECT ${authority(host, port)} HTTP/1.1\r\nHost: ${authority(host, port)}\r\n${auth}\r\n`
        )
        const reader = new Reader(socket)
        const response = await reader.headers()
        if (!/^HTTP\/1\.[01] 200\b/.test(response.toString('ascii')))
            throw new Error('Transport CONNECT failed')
        await reader.release()
        socket.setTimeout(0)
        return socket
    } catch (error) {
        socket.destroy()
        throw error
    }
}
export class TunBridge {
    private sockets = new Set<net.Socket>()
    private server = http.createServer((_req, res) => {
        res.writeHead(405)
        res.end()
    })
    port = 0
    constructor(
        private proxyPort: number,
        private egressURL: string,
        private password: string,
        private inspectTLS: (host: string) => boolean
    ) {
        this.server.on('connect', (req, stream, head) => {
            const socket = stream as net.Socket
            this.track(socket)
            void this.handle(req, socket, head).catch(() => socket.destroy())
        })
        this.server.on('connection', (socket) => this.track(socket))
        this.server.on('clientError', (_error, socket) => socket.destroy())
    }
    private track(socket: net.Socket) {
        this.sockets.add(socket)
        socket.on('error', () => {})
        socket.once('close', () => this.sockets.delete(socket))
    }
    private async handle(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
        const expected = Buffer.from(
            `Basic ${Buffer.from(`fluxy:${this.password}`).toString('base64')}`
        )
        const received = Buffer.from(String(req.headers['proxy-authorization'] ?? ''))
        if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
            socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n')
            return
        }
        const target = new URL(`http://${req.url}`)
        const port = Number(target.port) || 80
        if (
            target.username ||
            target.password ||
            target.pathname !== '/' ||
            target.search ||
            target.hash ||
            !target.hostname
        )
            throw new Error('Invalid CONNECT authority')
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        socket.setTimeout(10000, () => socket.destroy(new Error('Handshake timed out')))
        const reader = new Reader(socket, head)
        const initial = await initialPayload(reader)
        const host = target.hostname.replace(/^\[|\]$/g, '')
        const upstream =
            initial.protocol === 'http'
                ? await connect(this.proxyPort)
                : initial.protocol === 'tls' && initial.sni && this.inspectTLS(initial.sni)
                  ? await openTunnel(`http://127.0.0.1:${this.proxyPort}`, initial.sni, port)
                  : await openTunnel(this.egressURL, host, port)
        this.track(upstream)
        if (socket.destroyed) {
            upstream.destroy()
            return
        }
        await reader.release()
        socket.setTimeout(0)
        upstream.setTimeout(0)
        socket.once('close', () => upstream.destroy())
        upstream.once('close', () => socket.destroy())
        upstream.write(initial.wire)
        socket.pipe(upstream)
        upstream.pipe(socket)
    }
    async start() {
        this.server.listen(0, '127.0.0.1')
        await once(this.server, 'listening')
        this.port = (this.server.address() as net.AddressInfo).port
    }
    async stop() {
        for (const socket of this.sockets) socket.destroy()
        if (this.server.listening)
            await new Promise<void>((resolve) => this.server.close(() => resolve()))
    }
}
