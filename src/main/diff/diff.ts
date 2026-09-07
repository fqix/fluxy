import { timingLabels } from '../../shared/traffic/timing'
import { createHash } from 'node:crypto'
import { headerPairs } from '../../shared/traffic/filters'
import type { Transaction } from '../../shared/contracts/model'
import type { DiffTarget, DiffLine, DiffResult } from '../../shared/workspace/diff'
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const previewLimit = 512 * 1024
function utf8Prefix(bytes: Buffer, limit: number) {
    let end = Math.min(bytes.length, limit)
    if (end < bytes.length) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
    return bytes.subarray(0, end)
}
function lines(text: string) {
    const prefix = utf8Prefix(Buffer.from(text), previewLimit).toString()
    const items = prefix.split('\n')
    const limited = Buffer.byteLength(text) > previewLimit || items.length > 1000
    const result = items
        .slice(0, limited ? 999 : 1000)
        .map((line) =>
            line.length > 16384
                ? `${line.slice(0, 16384)}… [line limited; SHA-256 ${hash(line)}]`
                : line
        )
    if (limited) result.push(`Comparison limited · SHA-256 ${hash(text)}`)
    return result
}
export function diffText(old: string, current: string): DiffLine[] {
    const a = lines(old),
        b = lines(current),
        width = b.length + 1
    const dp = new Uint16Array((a.length + 1) * width)
    for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
            dp[i * width + j] =
                a[i - 1] === b[j - 1]
                    ? dp[(i - 1) * width + j - 1] + 1
                    : Math.max(dp[(i - 1) * width + j], dp[i * width + j - 1])
    let i = a.length,
        j = b.length
    const result: DiffLine[] = []
    while (i || j) {
        if (i && j && a[i - 1] === b[j - 1]) {
            result.push({ type: 'unchanged', content: a[i - 1], oldLine: i, newLine: j })
            i--
            j--
        } else if (i && (!j || dp[(i - 1) * width + j] > dp[i * width + j - 1])) {
            result.push({ type: 'removed', content: a[i - 1], oldLine: i })
            i--
        } else {
            result.push({ type: 'added', content: b[j - 1], newLine: j })
            j--
        }
    }
    return result.reverse()
}
function sorted(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sorted)
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, sorted(v)])
        )
    return value
}
function body(t: Transaction, side: 'request' | 'response') {
    const base64 = side === 'request' ? t.requestBase64 : t.responseBase64
    const text = side === 'request' ? t.requestBody : t.responseBody
    const type = (side === 'request' ? t.requestHeaders : t.responseHeaders)['content-type'] ?? ''
    const data = base64 ? Buffer.from(base64, 'base64') : Buffer.from(text)
    const prefix = utf8Prefix(data, previewLimit)
    let rendered: string
    try {
        if (
            /^(image|audio|video|font)\//i.test(type) ||
            /octet-stream|pdf|zip|protobuf/i.test(type) ||
            prefix.some((b) => b === 0 || b < 9 || (b > 13 && b < 32))
        )
            throw new Error('binary')
        rendered = new TextDecoder('utf-8', { fatal: true }).decode(prefix)
        if (data.length <= previewLimit) {
            try {
                rendered = JSON.stringify(sorted(JSON.parse(rendered)), null, 2)
            } catch {
                /* Text body. */
            }
        }
        if (!data.length) rendered = `No ${side} body`
        if (data.length > prefix.length)
            rendered += `\nBody preview limited to ${prefix.length} of ${data.length} captured bytes.\nSHA-256 (all captured bytes): ${hash(data)}`
    } catch {
        rendered = `Binary body\nSize: ${data.length} bytes\nContent-Type: ${type || 'unknown'}\nSHA-256 (captured bytes): ${hash(data)}`
    }
    if (t.truncated) rendered += '\nCapture truncated — comparison covers captured bytes only.'
    return rendered
}
export function diffSections(t: Transaction, target: DiffTarget): [string, string][] {
    const url = new URL(t.url)
    const unescape = (value: string) => {
        try {
            return decodeURIComponent(value)
        } catch {
            return value
        }
    }
    const decodedPath = unescape(url.pathname)
    const path = decodedPath === '/' ? decodedPath : decodedPath.replace(/\/+$/, '')
    const query = url.search
        .slice(1)
        .split('&')
        .filter(Boolean)
        .map((part) => {
            const equal = part.indexOf('=')
            return equal < 0
                ? `${unescape(part)}=`
                : `${unescape(part.slice(0, equal))}=${unescape(part.slice(equal + 1))}`
        })
    const headers = (side: 'request' | 'response') =>
        headerPairs(t, side)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n') || '(no headers)'
    if (target === 'Timing') {
        if (t.timings)
            return [
                [
                    'Timing',
                    Object.entries(timingLabels)
                        .map(
                            ([key, label]) =>
                                `${label}: ${t.timings?.[key as keyof typeof timingLabels] === undefined ? 'Unavailable' : t.timings[key as keyof typeof timingLabels]!.toFixed(1) + ' ms'}`
                        )
                        .join('\n') +
                        (t.timings.reusedConnection ? '\nReused upstream connection' : '')
                ]
            ]
        return [
            [
                'Timing',
                `Total measured duration: ${t.duration.toFixed(1)}ms\nDetailed phase timing unavailable`
            ]
        ]
    }
    if (target === 'Request')
        return [
            ['Request Line', `${t.method} ${path} HTTP/1.1`],
            ['Host', url.hostname],
            ['Query', query.join('\n') || '(no query parameters)'],
            ['Headers', headers('request')],
            ['Body', body(t, 'request')]
        ]
    return [
        ['Status Line', t.status ? `HTTP/1.1 ${t.status} ${t.statusMessage ?? ''}` : 'No response'],
        ['Headers', headers('response')],
        ['Body', body(t, 'response')]
    ]
}
export function compareTransactions(
    a: Transaction,
    b: Transaction,
    target: DiffTarget
): DiffResult {
    const right = new Map(diffSections(b, target))
    const sections = diffSections(a, target).map(([title, content]) => ({
        title,
        lines: diffText(content, right.get(title) ?? '')
    }))
    const all = sections.flatMap((s) => s.lines)
    return {
        sections,
        added: all.filter((l) => l.type === 'added').length,
        removed: all.filter((l) => l.type === 'removed').length
    }
}
