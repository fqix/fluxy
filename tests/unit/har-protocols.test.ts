import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fromHAR, toHAR } from '../../src/shared/traffic/har'
import { contentKind, transactionSchema } from '../../src/shared/contracts/model'
import { grpcWebTrailers, protocolPanels } from '../../src/shared/traffic/protocols'
import { decodeProtobuf } from '../../src/main/protocols/protobuf'

const fixture = JSON.parse(
    readFileSync(new URL('../fixtures/har/real-protocols.har', import.meta.url), 'utf8')
)
const schemas = ['grpcbin.proto', 'hello.proto'].map((name) => ({
    source: readFileSync(new URL(`../fixtures/har/${name}`, import.meta.url), 'utf8')
}))

describe('real HAR protocol regressions', () => {
    it('imports Chromium WebSocket messages, seconds, directions and secure transport', () => {
        const [t] = fromHAR(fixture)
        expect(t.protocol).toBe('WebSocket')
        expect(t.ssl).toBe(true)
        expect(contentKind(t)).toBe('WebSocket')
        expect(t.frames).toHaveLength(2)
        expect(t.frames.map((f) => [f.direction, f.body, f.binary])).toEqual([
            ['send', 'Fluxy real WebSocket capture test', false],
            ['receive', 'Fluxy real WebSocket capture test', false]
        ])
        expect(t.frames[0].time).toBe(fixture.log.entries[0]._webSocketMessages[0].time * 1000)
        const copy = fromHAR(toHAR([t]))[0]
        expect(copy.frames).toEqual(t.frames)
        expect(copy.protocol).toBe('WebSocket')
        transactionSchema.parse(copy)
    })

    it('keeps binary frames and Fluxy metadata without duplicating Chromium frames', () => {
        const t = fromHAR(fixture)[0]
        t.frames[0] = { ...t.frames[0], body: 'AAEC/w==', binary: true }
        t.pinned = true
        t.saved = true
        t.truncated = true
        t.error = 'Recorded failure'
        const har = toHAR([t])
        Object.assign(har.log.entries[0], {
            _webSocketMessages: fixture.log.entries[0]._webSocketMessages
        })
        expect(fromHAR(har)[0]).toMatchObject({
            frames: t.frames,
            pinned: true,
            saved: true,
            truncated: true,
            error: t.error
        })
    })

    it('recognizes HTTPS upgrade handshakes even without captured frames', () => {
        const e = structuredClone(fixture.log.entries[0])
        delete e._webSocketMessages
        e.request.url = 'https://httpbingo.org/websocket/echo'
        const t = fromHAR({ log: { entries: [e] } })[0]
        expect(t).toMatchObject({ protocol: 'WebSocket', ssl: true, frames: [] })
    })

    it('rejects invalid frame metadata before importing', () => {
        const e = structuredClone(fixture.log.entries[0])
        e._webSocketMessages[0].time = Infinity
        expect(() => fromHAR({ log: { entries: [e] } })).toThrow()
        e._webSocketMessages[0].time = 1
        e._webSocketMessages[0].data = 'x'.repeat(131073)
        expect(() => fromHAR({ log: { entries: [e] } })).toThrow()
    })

    it('preserves grpcbin trailers and wire bodies through import/export and decodes actual messages', () => {
        const transactions = fromHAR(fixture).slice(1)
        expect(transactions).toHaveLength(10)
        for (const [i, t] of transactions.entries()) {
            const original = fixture.log.entries[i + 1]
            expect(contentKind(t)).toBe('gRPC')
            expect(t.responseHeaders['grpc-status']).toBe(original._grpc.status)
            expect(protocolPanels(t).find((p) => p.title === 'gRPC')?.fields['gRPC status']).toBe(
                original._grpc.status
            )
            expect(
                decodeProtobuf(
                    schemas,
                    original._grpc.responseType,
                    Buffer.from(t.responseBase64!, 'base64'),
                    true
                )
            ).toEqual(original._grpc.decodedResponses)
            const copy = fromHAR(toHAR([t]))[0]
            expect(copy.responseHeaderEntries).toEqual(t.responseHeaderEntries)
            expect(copy.responseBase64).toBe(t.responseBase64)
            expect(copy.requestBase64).toBe(t.requestBase64)
            transactionSchema.parse(copy)
        }
        expect(transactions.filter((t) => t.responseHeaders['grpc-status'] !== '0')).toHaveLength(3)
    })

    it('uses MIME metadata and a base64 request extension when headers/Fluxy fields are absent', () => {
        const e = structuredClone(fixture.log.entries[3])
        e.request.headers = []
        e.response.headers = []
        delete e._fluxy
        const t = fromHAR({ log: { entries: [e] } })[0]
        expect(contentKind(t)).toBe('gRPC')
        expect(t.requestBase64).toBe(e.request.postData.text)
        expect(
            decodeProtobuf(
                schemas,
                'grpcbin.DummyMessage',
                Buffer.from(t.requestBase64!, 'base64'),
                true
            )
        ).toMatchObject([{ f_string: '真实 gRPC 测试 🧪', f_int32: 42 }])
        expect(
            contentKind({
                ...t,
                requestHeaders: {},
                responseHeaders: { 'content-type': 'application/grpc-not-a-protocol' }
            })
        ).toBe('Other')
    })

    it('skips only a final gRPC-Web trailer frame and still rejects malformed framing', () => {
        const schema = [{ source: 'syntax="proto3"; message Reply { string text = 1; }' }]
        const message = Buffer.from([0, 0, 0, 0, 4, 10, 2, 111, 107])
        const trailer = Buffer.from('grpc-status: 0\r\n')
        const head = Buffer.alloc(5)
        head[0] = 128
        head.writeUInt32BE(trailer.length, 1)
        const body = Buffer.concat([message, head, trailer])
        expect(decodeProtobuf(schema, 'Reply', body, true, '', true)).toEqual([{ text: 'ok' }])
        expect(() => decodeProtobuf(schema, 'Reply', body, true)).toThrow('Unsupported')
        expect(() =>
            decodeProtobuf(schema, 'Reply', Buffer.concat([body, message]), true, '', true)
        ).toThrow('final frame')
        expect(() => decodeProtobuf(schema, 'Reply', body.subarray(0, -1), true, '', true)).toThrow(
            'Truncated'
        )
    })
    it('reads gRPC-Web grpc-status from the trailer frame instead of the header block', () => {
        const message = Buffer.from([0, 0, 0, 0, 4, 10, 2, 111, 107])
        const trailer = Buffer.from('grpc-status: 5\r\ngrpc-message: Not%20Found\r\n')
        const head = Buffer.alloc(5)
        head[0] = 128
        head.writeUInt32BE(trailer.length, 1)
        const wire = Buffer.concat([message, head, trailer])
        const base = {
            ...fromHAR(fixture)[1],
            responseHeaders: { 'content-type': 'application/grpc-web+proto' },
            responseBody: '',
            responseBase64: wire.toString('base64')
        }
        expect(grpcWebTrailers(base)).toMatchObject({
            'grpc-status': '5',
            'grpc-message': 'Not%20Found'
        })
        const panel = protocolPanels(base).find((p) => p.title === 'gRPC')
        expect(panel?.fields['gRPC status']).toBe('5')
        expect(panel?.fields.Message).toBe('Not Found')

        // grpc-web-text base64-encodes the frame stream itself.
        const text = {
            ...base,
            responseHeaders: { 'content-type': 'application/grpc-web-text' },
            responseBase64: Buffer.from(wire.toString('base64')).toString('base64')
        }
        expect(grpcWebTrailers(text)['grpc-status']).toBe('5')

        // Plain gRPC keeps using the header block, and malformed bodies stay silent.
        expect(
            grpcWebTrailers({ ...base, responseHeaders: { 'content-type': 'application/grpc' } })
        ).toEqual({})
        expect(
            grpcWebTrailers({ ...base, responseBase64: message.subarray(0, 3).toString('base64') })
        ).toEqual({})
    })
})
