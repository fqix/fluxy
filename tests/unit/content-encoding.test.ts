import { describe, expect, it } from 'vitest'
import {
    brotliCompressSync,
    deflateRawSync,
    deflateSync,
    gzipSync,
    zstdCompressSync
} from 'node:zlib'
import { decode } from '../../src/main/capture/proxy'

const payload = Buffer.from(JSON.stringify({ hello: '世界', n: 1 }))

describe('response content-encoding', () => {
    it('decodes every encoding an origin negotiates with a modern browser', () => {
        expect(decode(gzipSync(payload), 'gzip')).toEqual(payload)
        expect(decode(brotliCompressSync(payload), 'br')).toEqual(payload)
        expect(decode(deflateSync(payload), 'deflate')).toEqual(payload)
        // Chromium advertises zstd since 123, so origins such as httpbingo.org return it.
        expect(decode(zstdCompressSync(payload), 'zstd')).toEqual(payload)
    })

    it('accepts bare DEFLATE that carries no zlib wrapper', () => {
        const raw = deflateRawSync(payload)
        expect(() => new TextDecoder('utf-8', { fatal: true }).decode(raw)).toThrow()
        expect(decode(raw, 'deflate')).toEqual(payload)
    })

    it('returns the original bytes for absent, unknown or corrupt encodings', () => {
        expect(decode(payload)).toEqual(payload)
        expect(decode(payload, 'identity')).toEqual(payload)
        expect(decode(payload, 'exi')).toEqual(payload)
        const truncated = gzipSync(payload).subarray(0, 10)
        expect(decode(truncated, 'gzip')).toEqual(truncated)
    })
    it('reports decompression beyond the capture ceiling without expanding the whole body', () => {
        const compressed = gzipSync(Buffer.alloc(2 * 1024 * 1024 + 1, 'a'))
        let limited = false
        expect(
            decode(compressed, 'gzip', () => {
                limited = true
            })
        ).toEqual(compressed)
        expect(limited).toBe(true)
    })
})
