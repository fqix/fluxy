import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
    filterFields,
    filterFieldValue,
    filterRuleSchema,
    compileFilter,
    activeFilterRules,
    filterError
} from '../../src/shared/traffic/filters'
import { fromHAR, toHAR } from '../../src/shared/traffic/har'
import { redactTransaction } from '../../src/shared/traffic/redaction'
import { compareTransactions, diffText, diffSections } from '../../src/main/diff/diff'
import { parseConnections, connectionOwner } from '../../src/main/capture/process-resolver'
import { matchesBreakpoint } from '../../src/main/rules/rule-match'
import { ruleSchema } from '../../src/shared/contracts/model'
import { parseBreakpointMessage } from '../../src/shared/rules/breakpoints'
function transaction() {
    return fromHAR({
        log: {
            entries: [
                {
                    startedDateTime: '2026-09-07T00:00:00Z',
                    time: 12,
                    request: {
                        method: 'POST',
                        url: 'https://example.com/api?q=hello',
                        headers: [
                            { name: 'content-type', value: 'application/json' },
                            { name: 'cookie', value: 'sid=123' }
                        ],
                        postData: { text: '{"value":1}' }
                    },
                    response: {
                        status: 200,
                        statusText: 'OK',
                        headers: [
                            { name: 'content-type', value: 'application/json' },
                            { name: 'set-cookie', value: 'a=1; Path=/' },
                            { name: 'set-cookie', value: 'b=2; Domain=example.com' }
                        ],
                        content: { text: '{"id":42,"name":"test"}' }
                    }
                }
            ]
        }
    })[0]
}
const filter = (value: object = {}) =>
    filterRuleSchema.parse({ id: randomUUID(), value: 'example', ...value })
describe('native advanced filtering semantics', () => {
    it('supports all 17 fields including repeated headers, cookies, app and notes', () => {
        const t = {
            ...transaction(),
            client: 'My App',
            note: 'important',
            highlight: 'purple' as const
        }
        expect(Object.keys(filterFields)).toHaveLength(17)
        const expected = {
            url: t.url,
            contains: t.url,
            host: t.host,
            domain: t.host,
            path: '/api',
            method: 'POST',
            statusCode: '200',
            requestHeader: 'cookie: sid=123',
            responseHeader: 'set-cookie: a=1',
            requestBody: '"value":1',
            responseBody: '"id":42',
            queryString: 'q=hello',
            cookies: 'b=2; domain=.example.com; path=/',
            clientApp: 'My App',
            contentType: 'application/json',
            comment: 'important',
            color: 'purple'
        }
        for (const [field, value] of Object.entries(expected))
            expect(filterFieldValue(t, field as keyof typeof filterFields)).toContain(value)
    })
    it.each([
        'contains',
        'is',
        'startsWith',
        'endsWith',
        'doesNotContain',
        'notEqual',
        'regex'
    ] as const)('evaluates %s case-insensitively', (operator) => {
        const value =
            operator === 'doesNotContain' || operator === 'notEqual'
                ? 'nope'
                : operator === 'regex'
                  ? '^EXAMPLE$'
                  : 'EXAMPLE'
        expect(compileFilter([filter({ operator, value })])(() => 'example')).toBe(true)
    })
    it('combines sequentially, ignores disabled/empty rows, and disables hidden filters', () => {
        const rules = [
            filter({ value: 'yes' }),
            filter({ value: 'no', connector: 'or' }),
            filter({ value: 'no', connector: 'and' })
        ]
        expect(compileFilter(rules)(() => 'yes')).toBe(false) // (true OR false) AND false
        expect(
            compileFilter([
                ...rules,
                filter({ value: 'yes', connector: 'or' }),
                filter({ value: 'missing', isEnabled: false }),
                filter({ value: '   ' })
            ])(() => 'yes')
        ).toBe(true)
        expect(activeFilterRules(rules, false)).toEqual([])
        expect(compileFilter([])(() => '')).toBe(true)
    })
    it('reports invalid regex and bounds body scanning', () => {
        const invalid = filter({ operator: 'regex', value: '[' })
        expect(filterError(invalid)).toBeTruthy()
        expect(compileFilter([invalid])(() => 'value')).toBe(false)
        expect(
            filterFieldValue(
                { ...transaction(), requestBody: 'x'.repeat(1000000) + 'hidden' },
                'requestBody'
            )
        ).not.toContain('hidden')
    })
})
describe('native diff semantics', () => {
    it('aligns insertions without cascading differences and keeps line numbers', () => {
        expect(diffText('a\nb\nc', 'a\nnew\nb\nc')).toEqual([
            { type: 'unchanged', content: 'a', oldLine: 1, newLine: 1 },
            { type: 'added', content: 'new', newLine: 2 },
            { type: 'unchanged', content: 'b', oldLine: 2, newLine: 3 },
            { type: 'unchanged', content: 'c', oldLine: 3, newLine: 4 }
        ])
    })
    it('normalizes JSON object order, compares request metadata and measured timing', () => {
        const a = transaction(),
            b = { ...a, responseBody: '{"name":"test","id":42}' }
        expect(compareTransactions(a, b, 'Response')).toMatchObject({ added: 0, removed: 0 })
        expect(
            compareTransactions(
                a,
                { ...b, method: 'PUT', url: 'https://example.com/api?q=other' },
                'Request'
            ).added
        ).toBe(2)
        expect(compareTransactions(a, { ...b, duration: 25 }, 'Timing')).toMatchObject({
            added: 1,
            removed: 1
        })
        expect(diffSections(a, 'Timing')[0][1]).toContain('Detailed phase timing unavailable')
    })
    it('preserves literal plus signs in query values and decodes the native display path', () => {
        const sections = new Map(
            diffSections(
                { ...transaction(), url: 'https://example.com/a%20b/?q=a+b&x=%2B' },
                'Request'
            )
        )
        expect(sections.get('Request Line')).toBe('POST /a b HTTP/1.1')
        expect(sections.get('Query')).toBe('q=a+b\nx=+')
    })
    it('compares binary bytes and long clipped tails by SHA-256', () => {
        const a = { ...transaction(), responseBase64: Buffer.from([0, 1, 2]).toString('base64') },
            b = { ...a, responseBase64: Buffer.from([0, 1, 3]).toString('base64') }
        expect(compareTransactions(a, b, 'Response')).toMatchObject({ added: 1, removed: 1 })
        const prefix = 'line\n'.repeat(1100)
        const difference = diffText(prefix + 'one', prefix + 'two').filter(
            (l) => l.type !== 'unchanged'
        )
        expect(difference).toHaveLength(2)
        expect(difference[0].content).toContain('SHA-256')
    })
    it('round trips repeated headers and redacts their values before export', () => {
        const t = transaction()
        expect(fromHAR(toHAR([t]))[0].responseHeaderEntries).toEqual(t.responseHeaderEntries)
        const redacted = JSON.stringify(toHAR([redactTransaction(t)]))
        expect(redacted).not.toContain('sid=123')
        expect(redacted).not.toContain('a=1;')
    })
})
describe('connection ownership', () => {
    const text =
        'p11\ncFluxy\nn127.0.0.1:9000->127.0.0.1:5000\np22\ncClient\nn127.0.0.1:5000->127.0.0.1:9000\np33\ncOther\nn192.168.0.1:5000->127.0.0.1:9000\n'
    const socket = {
        remoteAddress: '::ffff:127.0.0.1',
        remotePort: 5000,
        localAddress: '127.0.0.1',
        localPort: 9000
    }
    it('matches the complete client-side tuple, excludes the proxy and rejects ambiguous owners', () => {
        const rows = parseConnections(text)
        expect(connectionOwner(rows, socket, 11)?.pid).toBe(22)
        expect(
            connectionOwner(rows, { ...socket, remoteAddress: '192.168.0.2' }, 11)
        ).toBeUndefined()
        expect(connectionOwner([...rows, { ...rows[1], pid: 44 }], socket, 11)).toBeUndefined()
    })
})
describe('breakpoint matching and raw edits', () => {
    const rule = (extra: object = {}) =>
        ruleSchema.parse({
            id: randomUUID(),
            name: 'Test',
            kind: 'breakpoint',
            enabled: true,
            pattern: 'example.com/api',
            matchType: 'wildcard',
            ...extra
        })
    it('matches native URL boundaries, subpaths and header/method conjunctions', () => {
        expect(matchesBreakpoint(rule(), 'GET', 'https://example.com/api?q=1', {})).toBe(true)
        expect(matchesBreakpoint(rule(), 'GET', 'https://example.com/apix', {})).toBe(false)
        expect(
            matchesBreakpoint(
                rule({ includeSubpaths: true }),
                'GET',
                'https://example.com/api/one',
                {}
            )
        ).toBe(true)
        expect(
            matchesBreakpoint(
                rule({ includeSubpaths: true }),
                'GET',
                'https://example.com/apix',
                {}
            )
        ).toBe(false)
        const r = rule({ method: 'post', matchHeaderName: 'X-Test', matchHeaderValue: 'yes' })
        expect(matchesBreakpoint(r, 'POST', 'https://example.com/api', { 'x-test': 'yes' })).toBe(
            true
        )
        expect(matchesBreakpoint(r, 'POST', 'https://example.com/api', { 'x-test': 'Yes' })).toBe(
            false
        )
    })
    it('bounds malicious regex evaluation', () => {
        const started = Date.now()
        expect(
            matchesBreakpoint(
                rule({ pattern: '(a+)+$', matchType: 'regex' }),
                'GET',
                'https://example.com/' + 'a'.repeat(1000) + '!',
                {}
            )
        ).toBe(false)
        expect(Date.now() - started).toBeLessThan(500)
    })
    it('supports extension methods, exact path encoding, repeated headers and locked TLS authority', () => {
        expect(
            parseBreakpointMessage(
                'PROPFIND //api/%2F?q=%26 HTTP/1.1\nX: a\nX: b\n\n',
                'request',
                'https://example.com/'
            )
        ).toMatchObject({
            method: 'PROPFIND',
            url: 'https://example.com//api/%2F?q=%26',
            headerEntries: [
                { name: 'x', value: 'a' },
                { name: 'x', value: 'b' }
            ]
        })
        expect(() =>
            parseBreakpointMessage(
                'GET https://elsewhere.com/ HTTP/1.1\n\n',
                'request',
                'https://example.com/'
            )
        ).toThrow('TLS authority')
        expect(() =>
            parseBreakpointMessage('GET / HTTP/1.1\nX: bad\0value\n\n', 'request')
        ).toThrow()
    })
})
