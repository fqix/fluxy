import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { ProxyWire } from '../../src/main/capture/proxy-wire'

it('preserves binary data across fragmented and coalesced IPC frames', () => {
    const output = new PassThrough()
    const writer = new ProxyWire(output)
    const input: Buffer[] = []
    output.on('data', (chunk) => input.push(chunk))
    const messages = [
        { type: 'chunk', stream: 'first', data: Buffer.from([0, 127, 128, 255]) },
        { type: 'end', stream: 'first', trailers: { 'grpc-status': '0' } },
        { type: 'certificate', identity: { ca: Buffer.from('private pipe only') } }
    ]
    for (const message of messages) writer.send(message)
    const receiver = new ProxyWire(new PassThrough())
    const decoded: unknown[] = []
    receiver.on('message', (message) => decoded.push(message))
    const wire = Buffer.concat(input)
    for (let offset = 0; offset < wire.length; offset += 7)
        receiver.receive(wire.subarray(offset, offset + 7))
    expect(decoded).toEqual(messages)
})

it('rejects invalid or oversized frames before allocating their payload', () => {
    for (const length of [0, 145 * 1024 * 1024]) {
        const receiver = new ProxyWire(new PassThrough())
        const header = Buffer.alloc(4)
        header.writeUInt32BE(length)
        expect(() => receiver.receive(header)).toThrow('frame length')
    }
})
