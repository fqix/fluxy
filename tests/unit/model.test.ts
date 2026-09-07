import { describe, it, expect } from 'vitest'
import {
    matchPattern,
    matchesRule,
    ruleSchema,
    composeSchema,
    settingsSchema,
    toCurl
} from '../../src/shared/contracts/model'
import { fromHAR, toHAR } from '../../src/shared/traffic/har'
import { randomUUID } from 'node:crypto'
describe('matching and validation', () => {
    it('treats glob metacharacters literally and matches complete URLs', () => {
        expect(
            matchPattern('https://*.example.com/api/*', 'https://a.example.com/api/test?q=a')
        ).toBe(true)
        expect(matchPattern('https://example.com/a.b', 'https://example.com/axb')).toBe(false)
        expect(
            matchPattern('https://example.com/*', 'https://evil.com/https://example.com/a')
        ).toBe(false)
        expect(matchPattern('*[abc]*', 'https://x/[abc]')).toBe(true)
    })
    it('honors rule enablement and method', () => {
        const r = ruleSchema.parse({
            id: randomUUID(),
            name: 'Block',
            pattern: '*',
            kind: 'block',
            enabled: false,
            method: 'POST'
        })
        expect(matchesRule(r, 'POST', 'https://a.com')).toBe(false)
        expect(matchesRule({ ...r, enabled: true }, 'GET', 'https://a.com')).toBe(false)
        expect(matchesRule({ ...r, enabled: true }, 'POST', 'https://a.com')).toBe(true)
    })
    it('rejects invalid ports, non-http URLs and header injection', () => {
        expect(settingsSchema.safeParse({ port: 80 }).success).toBe(false)
        expect(
            composeSchema.safeParse({ url: 'file:///etc/passwd', method: 'GET', headers: {} })
                .success
        ).toBe(false)
        expect(
            composeSchema.safeParse({
                url: 'https://a.com',
                method: 'GET',
                headers: { 'x-test': 'x\r\nHost: evil' }
            }).success
        ).toBe(false)
    })
    it('quotes cURL values without executing shell syntax', () => {
        expect(
            toCurl({
                method: 'POST',
                url: "https://a.com/?q='$(id)",
                requestHeaders: {},
                requestBody: '`whoami`'
            })
        ).toContain("'\\''")
    })
})
describe('HAR compatibility', () => {
    const har = {
        log: {
            entries: [
                {
                    startedDateTime: '2026-09-07T00:00:00Z',
                    time: 31,
                    request: {
                        method: 'POST',
                        url: 'https://example.com/api?q=1',
                        headers: [{ name: 'Content-Type', value: 'application/json' }],
                        postData: { text: '{"a":1}' },
                        bodySize: 7
                    },
                    response: {
                        status: 201,
                        statusText: 'Created',
                        headers: [{ name: 'Content-Type', value: 'application/octet-stream' }],
                        content: { size: 3, text: 'AAEC', encoding: 'base64' }
                    },
                    comment: 'note'
                }
            ]
        }
    }
    it('round-trips binary bodies, headers, request bodies and timings', () => {
        const [transaction] = fromHAR(har)
        const [copy] = fromHAR(toHAR([transaction]))
        expect(copy.responseBase64).toBe('AAEC')
        expect(copy.requestBody).toBe('{"a":1}')
        expect(copy.duration).toBe(31)
        expect(copy.requestHeaders['content-type']).toBe('application/json')
        expect(copy.note).toBe('note')
    })
    it('rejects malformed imports before replacing traffic', () => {
        expect(() => fromHAR({ log: { entries: [{}] } })).toThrow()
        expect(() =>
            fromHAR({ log: { entries: [{ ...har.log.entries[0], startedDateTime: 'invalid' }] } })
        ).toThrow()
    })
})
