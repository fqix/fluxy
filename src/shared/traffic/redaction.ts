import type { Transaction } from '../contracts/model'
const sensitive =
    /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|password|passwd|secret|client[-_]?secret|private[-_]?key|session[-_]?id)$/i
export function redactValue(value: unknown, depth = 0): unknown {
    if (depth > 30) return '[depth limit]'
    if (Array.isArray(value)) return value.slice(0, 1000).map((v) => redactValue(v, depth + 1))
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.entries(value).map(([key, v]) => [
                key,
                sensitive.test(key) ? '[REDACTED]' : redactValue(v, depth + 1)
            ])
        )
    return value
}
export function redactTransaction(t: Transaction): Transaction {
    const url = new URL(t.url)
    for (const key of [...url.searchParams.keys()])
        if (sensitive.test(key)) url.searchParams.set(key, '[REDACTED]')
    url.username = ''
    url.password = ''
    if (url.hash) url.hash = '[REDACTED]'
    const body = (s: string) => {
        if (!s) return ''
        try {
            return JSON.stringify(redactValue(JSON.parse(s))).slice(0, 32768)
        } catch {
            return '[Non-JSON payload omitted by redaction policy]'
        }
    }
    return {
        ...t,
        url: url.href,
        path: url.pathname + url.search,
        requestHeaders: redactValue(t.requestHeaders) as Transaction['requestHeaders'],
        responseHeaders: redactValue(t.responseHeaders) as Transaction['responseHeaders'],
        requestHeaderEntries: t.requestHeaderEntries?.map((h) => ({
            ...h,
            value: sensitive.test(h.name) ? '[REDACTED]' : h.value
        })),
        responseHeaderEntries: t.responseHeaderEntries?.map((h) => ({
            ...h,
            value: sensitive.test(h.name) ? '[REDACTED]' : h.value
        })),
        clientPID: undefined,
        clientIdentity: undefined,
        requestBody: body(t.requestBody),
        responseBody: body(t.responseBody),
        requestBase64: undefined,
        responseBase64: undefined,
        frames: [],
        note: t.note ? '[Note omitted]' : '',
        error: t.error ? '[Transport error; inspect locally]' : undefined
    }
}
