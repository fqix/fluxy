import { headerPairs } from './filters'
import {
    requestEditSchema,
    responseEditSchema,
    type BreakpointEdit,
    type Transaction
} from './model'

export function breakpointMessage(t: Transaction, phase: 'request' | 'response'): string {
    const first =
        phase === 'request'
            ? `${t.method} ${t.url} HTTP/1.1`
            : `HTTP/1.1 ${t.status ?? 200} ${t.statusMessage ?? 'OK'}`
    const values = headerPairs(t, phase)
    return (
        first +
        '\n' +
        values.map(([k, v]) => `${k}: ${v}`).join('\n') +
        '\n\n' +
        (t.breakpointBodyEditable === false
            ? ''
            : phase === 'request'
              ? t.requestBody
              : t.responseBody)
    )
}
export function parseBreakpointMessage(
    raw: string,
    phase: 'request' | 'response',
    baseURL?: string,
    preserveBody = false
): BreakpointEdit {
    const split = /\r?\n\r?\n/.exec(raw)
    const head = split ? raw.slice(0, split.index) : raw
    const body = split ? raw.slice(split.index + split[0].length) : ''
    const [first, ...lines] = head.split(/\r?\n/)
    const headers: Record<string, string> = Object.create(null)
    const headerEntries: { name: string; value: string }[] = []
    for (const line of lines) {
        const index = line.indexOf(':')
        if (index <= 0) throw new Error('Each header needs a name and a value separated by a colon')
        const name = line.slice(0, index).trim().toLowerCase()
        const value = line.slice(index + 1).trim()
        headerEntries.push({ name, value })
        headers[name] = value
    }
    if (phase === 'response') {
        const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s.*)?$/.exec(first)
        if (!match) throw new Error('Response must start with HTTP/1.1 and a status code')
        return responseEditSchema.parse({
            status: Number(match[1]),
            headers,
            headerEntries,
            body,
            preserveBody
        })
    }
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s+(\S+)\s+HTTP\/\d(?:\.\d)?$/.exec(first)
    if (!match) throw new Error('Request must start with METHOD URL HTTP/1.1')
    const base = new URL(baseURL ?? 'https://example.com/')
    if (headers.host) base.host = headers.host
    // Origin-form targets beginning with // are paths, never a new authority.
    const target = match[2].startsWith('/') ? base.origin + match[2] : match[2]
    const url = new URL(target, base)
    if (
        baseURL &&
        new URL(baseURL).protocol === 'https:' &&
        url.origin !== new URL(baseURL ?? 'https://example.com/').origin
    )
        throw new Error(
            'HTTPS breakpoints can edit only the path and query; the TLS authority is fixed'
        )
    return requestEditSchema.parse({
        method: match[1],
        url: url.href,
        headerEntries,
        preserveBody,
        headers,
        body
    })
}
