import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { once } from 'node:events'
import https from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import { HttpsProxyAgent } from 'https-proxy-agent'
import WebSocket, { WebSocketServer } from 'ws'
import { startProxy } from '../protocol/engine'
import { origins } from '../protocol/fixtures'
import { sendFragmentedMessage } from '../../tools/whistle/websocket-fragments'

type Frame = { fin: boolean; opcode: number; length: number; masked: boolean }

// Inspect actual wire headers independently of ws's message/receiver internals.
function observeFrames(ws: WebSocket, onFrame?: (frame: Frame) => void) {
    const frames: Frame[] = []
    let buffered: Buffer = Buffer.alloc(0)
    const socket = (ws as WebSocket & { _socket: Socket })._socket
    socket.prependListener('data', (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk])
        while (buffered.length >= 2) {
            let length = buffered[1] & 127
            let header = 2
            if (length === 126) {
                if (buffered.length < 4) return
                length = buffered.readUInt16BE(2)
                header = 4
            } else if (length === 127) {
                if (buffered.length < 10) return
                length = Number(buffered.readBigUInt64BE(2))
                header = 10
            }
            const masked = !!(buffered[1] & 128)
            if (masked) header += 4
            if (buffered.length < header + length) return
            const frame = { fin: !!(buffered[0] & 128), opcode: buffered[0] & 15, length, masked }
            buffered = buffered.subarray(header + length)
            frames.push(frame)
            onFrame?.(frame)
        }
    })
    return frames
}

function send(ws: WebSocket, body: Buffer, binary: boolean, lengths: number[], ping = false) {
    let offset = 0
    for (let index = 0; index < lengths.length; index++) {
        const length = lengths[index]
        ws.send(body.subarray(offset, offset + length), {
            binary,
            fin: index === lengths.length - 1
        })
        offset += length
        if (ping && index === 0) ws.ping('between fragments')
    }
}

function expected(lengths: number[], binary: boolean, masked: boolean): Frame[] {
    return lengths.map((length, index) => ({
        length,
        opcode: index === 0 ? (binary ? 2 : 1) : 0,
        fin: index === lengths.length - 1,
        masked
    }))
}

let fixture: Awaited<ReturnType<typeof origins>>
let proxy: Awaited<ReturnType<typeof startProxy>>
beforeAll(async () => {
    fixture = await origins()
    proxy = await startProxy(fixture.tls.cert, [])
})
afterAll(async () => {
    await proxy?.stop()
    await fixture?.stop()
})

async function connection(run: (origin: WebSocket, client: WebSocket) => Promise<void>) {
    const server = https.createServer(fixture.tls)
    const wss = new WebSocketServer({ server, perMessageDeflate: false })
    const agent = new HttpsProxyAgent(`http://127.0.0.1:${proxy.port}`)
    let client: WebSocket | undefined
    try {
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        const connected = once(wss, 'connection')
        client = new WebSocket(
            `wss://localhost:${(server.address() as AddressInfo).port}/fragments`,
            {
                agent,
                ca: proxy.ca,
                perMessageDeflate: false,
                handshakeTimeout: 5000
            }
        )
        client.on('error', () => {})
        const [[origin]] = await Promise.all([connected, once(client, 'open')])
        await run(origin, client)
    } finally {
        client?.terminate()
        for (const socket of wss.clients) socket.terminate()
        agent.destroy()
        await new Promise<void>((resolve) => wss.close(() => resolve()))
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
}

describe('WSS fragmentation through the production proxy child', () => {
    it.each([
        { name: '4 KiB text', body: Buffer.alloc(4096, 65), binary: false, lengths: [2048, 2048] },
        {
            name: '10 KiB binary',
            body: Buffer.alloc(10240, 0xa5),
            binary: true,
            lengths: [2048, 2048, 2048, 2048, 2048]
        },
        {
            name: 'split UTF-8 and empty frames',
            body: Buffer.from('中文🙂'),
            binary: false,
            lengths: [0, 1, 0, 3, 6, 0]
        },
        { name: 'empty message', body: Buffer.alloc(0), binary: true, lengths: [0, 0] }
    ])(
        'preserves $name in both directions and keeps messages ordered',
        async ({ body, binary, lengths }) => {
            await connection(async (origin, client) => {
                const receivedFrames = observeFrames(origin)
                const echoedFrames = observeFrames(client)
                const responses: Buffer[] = []
                origin.on('message', (data, isBinary) => {
                    expect(isBinary).toBe(binary)
                    send(origin, data as Buffer, isBinary, lengths, true)
                })
                client.on('message', (data, isBinary) => {
                    expect(isBinary).toBe(binary)
                    responses.push(Buffer.from(data as Buffer))
                })
                // Queue two complete messages before the asynchronous IPC hook returns.
                send(client, body, binary, lengths, true)
                send(client, body, binary, lengths)
                await expect.poll(() => responses.length).toBe(2)
                expect(responses).toEqual([body, body])
                expect(receivedFrames.filter((frame) => frame.opcode < 8)).toEqual([
                    ...expected(lengths, binary, true),
                    ...expected(lengths, binary, true)
                ])
                expect(echoedFrames.filter((frame) => frame.opcode < 8)).toEqual([
                    ...expected(lengths, binary, false),
                    ...expected(lengths, binary, false)
                ])
                const closed = once(client, 'close')
                client.close(1000, 'complete')
                expect((await closed)[0]).toBe(1000)
                await expect
                    .poll(async () =>
                        (await proxy.snapshot()).some(
                            (capture) =>
                                capture.frames.length === 4 &&
                                capture.frames.every((frame) =>
                                    Buffer.from(frame.data, 'base64').equals(body)
                                )
                        )
                    )
                    .toBe(true)
            })
        }
    )

    it.each([
        { lengths: [2049], code: 1002 },
        { lengths: [2048, 2048, 2048, 2048, 2048, 1], code: 1009 }
    ])('preserves upstream rejection $code at the original limit', async ({ lengths, code }) => {
        await connection(async (origin, client) => {
            let total = 0
            observeFrames(origin, (frame) => {
                if (frame.opcode >= 8) return
                total += frame.length
                if (frame.length > 2048) origin.close(1002, 'fragment limit')
                else if (total > 10240) origin.close(1009, 'message limit')
            })
            const closed = once(client, 'close')
            send(client, Buffer.alloc(lengths.reduce((a, b) => a + b, 0)), true, lengths)
            expect((await closed)[0]).toBe(code)
        })
    })

    it.each([
        { size: 9, lengths: [2, 2], output: [2, 2, 2, 2, 1] },
        { size: 1, lengths: [2, 2], output: [1] },
        { size: 0, lengths: [2, 2], output: [0] }
    ])('keeps modified messages of $size bytes valid', async ({ size, lengths, output }) => {
        await connection(async (origin, client) => {
            const wire = observeFrames(client)
            const message = once(client, 'message')
            await sendFragmentedMessage(origin, Buffer.alloc(size, 0x61), false, lengths)
            const [body, binary] = await message
            expect(body).toEqual(Buffer.alloc(size, 0x61))
            expect(binary).toBe(false)
            expect(wire.filter((frame) => frame.opcode < 8)).toEqual(expected(output, false, false))
        })
    })
})
