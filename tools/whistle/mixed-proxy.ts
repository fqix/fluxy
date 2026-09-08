import http from 'node:http'
import type net from 'node:net'

// sockx is pinned by the Whistle runtime lockfile. Its internal net.Server lets
// us reuse its SOCKS5 parser without creating a second listening port.
export function enableMixedProxy(
    server: http.Server,
    socks: any,
    port: number,
    clientHeader: string
) {
    const socksServer = socks.createServer((info: any, accept: any, deny: any) => {
        const host = info.dstAddr.includes(':') ? `[${info.dstAddr}]` : info.dstAddr
        const destination = `${host}:${info.dstPort}`
        const request = http.request({
            host: '127.0.0.1',
            port,
            method: 'CONNECT',
            path: destination,
            agent: false,
            headers: {
                host: destination,
                'x-whistle-server': 'socks',
                [clientHeader]: [info.srcAddr, info.srcPort, info.srcAddr, info.srcPort].join()
            }
        })
        request.setTimeout(15000, () =>
            request.destroy(new Error('SOCKS5 target connection timed out'))
        )
        request.once('error', () => deny())
        request.once('connect', (response, upstream, head) => {
            if (response.statusCode !== 200) {
                upstream.destroy()
                deny()
                return
            }
            const client = accept(true) as net.Socket | false
            if (!client) {
                upstream.destroy()
                return
            }
            client.setTimeout(0)
            upstream.setTimeout(0)
            client.once('error', () => upstream.destroy())
            upstream.once('error', () => client.destroy())
            client.once('close', () => upstream.destroy())
            upstream.once('close', () => client.destroy())
            if (head.length) client.write(head)
            client.pipe(upstream).pipe(client)
        })
        request.end()
    })
    socksServer.useAuth(socks.auth.None())
    const socksTransport = socksServer._srv as net.Server
    if (!socksTransport?.emit) throw new Error('Unsupported Whistle SOCKS5 runtime')
    const httpHandlers = server.listeners('connection')
    server.removeAllListeners('connection')
    server.on('connection', (socket: net.Socket) => {
        socket.on('error', () => socket.destroy())
        socket.setTimeout(15000, () => socket.destroy())
        socket.once('data', (data: Buffer) => {
            socket.pause()
            socket.unshift(data)
            if (data[0] === 5) socksTransport.emit('connection', socket)
            else {
                socket.setTimeout(0)
                for (const handler of httpHandlers) handler.call(server, socket)
            }
            socket.resume()
        })
    })
}
