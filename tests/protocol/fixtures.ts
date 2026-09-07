import http from 'node:http'
import https from 'node:https'
import type net from 'node:net'
import { once } from 'node:events'
import forge from 'node-forge'
import * as grpc from '@grpc/grpc-js'
import protobuf from 'protobufjs'
import { WebSocketServer } from 'ws'

export const Message = protobuf
    .parse('syntax = "proto3"; message Message { string text = 1; }')
    .root.lookupType('Message')
export type Payload = { text: string }
export const serialize = (value: Payload) => Buffer.from(Message.encode(value).finish())
export const deserialize = (bytes: Buffer): Payload =>
    Message.toObject(Message.decode(bytes)) as Payload
const method = (
    name: string,
    requestStream: boolean,
    responseStream: boolean
): grpc.MethodDefinition<Payload, Payload> => ({
    path: `/fluxy.fixture.Echo/${name}`,
    requestStream,
    responseStream,
    requestSerialize: serialize,
    requestDeserialize: deserialize,
    responseSerialize: serialize,
    responseDeserialize: deserialize
})
export const service = {
    unary: method('Unary', false, false),
    clientStream: method('ClientStream', true, false),
    serverStream: method('ServerStream', false, true),
    bidi: method('Bidi', true, true),
    fail: method('Fail', false, false),
    cancel: method('Cancel', false, true)
}

function certificate() {
    const keys = forge.pki.rsa.generateKeyPair(2048)
    const cert = forge.pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = '01'
    cert.validity.notBefore = new Date(Date.now() - 60_000)
    cert.validity.notAfter = new Date(Date.now() + 86_400_000)
    const attrs = [{ name: 'commonName', value: 'localhost' }]
    cert.setSubject(attrs)
    cert.setIssuer(attrs)
    cert.setExtensions([
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
        {
            name: 'subjectAltName',
            altNames: [
                { type: 2, value: 'localhost' },
                { type: 7, ip: '127.0.0.1' }
            ]
        }
    ])
    cert.sign(keys.privateKey, forge.md.sha256.create())
    return {
        key: forge.pki.privateKeyToPem(keys.privateKey),
        cert: forge.pki.certificateToPem(cert)
    }
}

export async function origins() {
    const tls = certificate()
    const releases = new Map<string, () => void>()
    const received = new Set<string>()
    const cancelled = new Set<string>()
    const handler: http.RequestListener = (req, res) => {
        if (req.url?.startsWith('/sse/')) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
            res.write('id: 1\ndata: first\n\n')
            releases.set(req.url, () => res.end('id: 2\ndata: second\n\n'))
            res.on('close', () => cancelled.add(req.url!))
        } else {
            const chunks: Buffer[] = []
            req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
            req.on('end', () => {
                res.writeHead(200, {
                    'content-type': 'application/octet-stream',
                    'x-origin': 'fixture'
                })
                res.end(Buffer.concat(chunks))
            })
        }
    }
    const plain = http.createServer(handler),
        secure = https.createServer(tls, handler)
    const servers = [plain, secure]
    const sockets = new Set<net.Socket>()
    const websockets = servers.map((server) => {
        server.on('connection', (socket) => {
            sockets.add(socket)
            socket.once('close', () => sockets.delete(socket))
        })
        const ws = new WebSocketServer({ server })
        ws.on('connection', (socket) =>
            socket.on('message', (data, binary) => socket.send(data, { binary }))
        )
        return ws
    })
    for (const server of servers) {
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
    }
    const trailer = () => {
        const metadata = new grpc.Metadata()
        metadata.set('x-fluxy-trailer', 'finished')
        return metadata
    }
    const grpcServers: grpc.Server[] = []
    const grpcPorts: number[] = []
    for (const secure of [false, true]) {
        const server = new grpc.Server()
        server.addService(service, {
            unary(
                call: grpc.ServerUnaryCall<Payload, Payload>,
                callback: grpc.sendUnaryData<Payload>
            ) {
                callback(null, call.request, trailer())
            },
            clientStream(
                call: grpc.ServerReadableStream<Payload, Payload>,
                callback: grpc.sendUnaryData<Payload>
            ) {
                const values: string[] = []
                call.on('data', (value: Payload) => {
                    values.push(value.text)
                    received.add(value.text)
                })
                call.on('end', () => callback(null, { text: values.join(',') }, trailer()))
            },
            serverStream(call: grpc.ServerWritableStream<Payload, Payload>) {
                call.write({ text: `${call.request.text}:first` })
                releases.set(call.request.text, () => {
                    call.write({ text: `${call.request.text}:second` })
                    call.end(trailer())
                })
            },
            bidi(call: grpc.ServerDuplexStream<Payload, Payload>) {
                call.on('data', (value: Payload) => call.write(value))
                call.on('end', () => call.end(trailer()))
            },
            fail(
                _call: grpc.ServerUnaryCall<Payload, Payload>,
                callback: grpc.sendUnaryData<Payload>
            ) {
                callback({
                    code: grpc.status.INVALID_ARGUMENT,
                    details: 'fixture rejected',
                    metadata: trailer()
                })
            },
            cancel(call: grpc.ServerWritableStream<Payload, Payload>) {
                call.write({ text: 'started' })
                call.on('cancelled', () => cancelled.add(call.request.text))
            }
        })
        grpcServers.push(server)
        grpcPorts.push(
            await new Promise<number>((resolve, reject) =>
                server.bindAsync(
                    '127.0.0.1:0',
                    secure
                        ? grpc.ServerCredentials.createSsl(null, [
                              {
                                  private_key: Buffer.from(tls.key),
                                  cert_chain: Buffer.from(tls.cert)
                              }
                          ])
                        : grpc.ServerCredentials.createInsecure(),
                    (error, port) => (error ? reject(error) : resolve(port))
                )
            )
        )
    }
    return {
        tls,
        received,
        releases,
        cancelled,
        httpPort: (plain.address() as net.AddressInfo).port,
        httpsPort: (secure.address() as net.AddressInfo).port,
        grpcPort: grpcPorts[0],
        grpcsPort: grpcPorts[1],
        async stop() {
            for (const server of grpcServers) server.forceShutdown()
            for (const ws of websockets) {
                for (const client of ws.clients) client.terminate()
                ws.close()
            }
            for (const socket of sockets) socket.destroy()
            await Promise.all(
                servers.map(
                    (server) => new Promise<void>((resolve) => server.close(() => resolve()))
                )
            )
        }
    }
}
