import { timingSchema } from './timing'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { highlightSchema, type Transaction } from './model'

export function toHAR(items: Transaction[]) {
    const headers = (h: Record<string, string>) =>
        Object.entries(h).map(([name, value]) => ({ name, value }))
    return {
        log: {
            version: '1.2',
            creator: { name: 'Fluxy', version: '0.1.0' },
            entries: items.map((t) => ({
                startedDateTime: new Date(t.timestamp).toISOString(),
                time: t.duration,
                request: {
                    method: t.method,
                    url: t.url,
                    httpVersion: 'HTTP/1.1',
                    cookies: [],
                    headers: t.requestHeaderEntries ?? headers(t.requestHeaders),
                    queryString: [...new URL(t.url).searchParams].map(([name, value]) => ({
                        name,
                        value
                    })),
                    headersSize: -1,
                    bodySize: t.requestBytes,
                    ...(t.requestBody
                        ? {
                              postData: {
                                  mimeType: t.requestHeaders['content-type'] || 'text/plain',
                                  text: t.requestBody
                              }
                          }
                        : {})
                },
                response: {
                    status: t.status ?? 0,
                    statusText: t.statusMessage ?? '',
                    httpVersion: 'HTTP/1.1',
                    cookies: [],
                    headers: t.responseHeaderEntries ?? headers(t.responseHeaders),
                    content: {
                        size: t.responseBytes,
                        mimeType: t.responseHeaders['content-type'] || 'application/octet-stream',
                        text: t.responseBase64 ?? t.responseBody,
                        ...(t.responseBase64 ? { encoding: 'base64' } : {})
                    },
                    redirectURL: t.responseHeaders.location ?? '',
                    headersSize: -1,
                    bodySize: t.responseBytes
                },
                cache: {},
                timings: t.timings
                    ? Object.fromEntries(
                          ['blocked', 'dns', 'connect', 'ssl', 'send', 'wait', 'receive'].map(
                              (key) => [key, t.timings![key as keyof typeof t.timings] ?? -1]
                          )
                      )
                    : { send: 0, wait: t.duration, receive: 0 },
                comment: t.note,
                _fluxy: {
                    highlight: t.highlight,
                    requestBase64: t.requestBase64,
                    pinned: t.pinned,
                    saved: t.saved,
                    frames: t.frames,
                    truncated: t.truncated,
                    error: t.error
                }
            }))
        }
    }
}
const headerSchema = z
    .array(z.object({ name: z.string().max(1000), value: z.string().max(100000) }))
    .max(5000)
    .default([])
const entrySchema = z.object({
    startedDateTime: z.string().refine((s) => Number.isFinite(Date.parse(s))),
    time: z.number().min(0).default(0),
    timings: z.record(z.string(), z.number()).optional(),
    request: z.object({
        method: z.string().max(30),
        url: z
            .string()
            .url()
            .refine((s) => /^(https?|wss?):\/\//.test(s)),
        headers: headerSchema,
        bodySize: z.number().default(0),
        postData: z
            .object({
                text: z
                    .string()
                    .max(4 * 1024 * 1024)
                    .default('')
            })
            .optional()
    }),
    response: z.object({
        status: z.number().int().min(0).max(599),
        statusText: z.string().default(''),
        headers: headerSchema,
        content: z
            .object({
                size: z.number().default(0),
                text: z
                    .string()
                    .max(8 * 1024 * 1024)
                    .default(''),
                encoding: z.string().optional()
            })
            .default({ size: 0, text: '' })
    }),
    comment: z.string().max(100000).default(''),
    _fluxy: z
        .object({
            highlight: highlightSchema.optional(),
            requestBase64: z
                .string()
                .max(4 * 1024 * 1024)
                .optional()
        })
        .optional()
})
export function fromHAR(input: unknown): Transaction[] {
    const har = z
        .object({ log: z.object({ entries: z.array(entrySchema).max(50000) }) })
        .parse(input)
    return har.log.entries.map((e, i) => {
        const url = new URL(e.request.url)
        const binary = e.response.content.encoding === 'base64'
        return {
            id: randomUUID(),
            sequence: i + 1,
            timestamp: Date.parse(e.startedDateTime),
            method: e.request.method,
            url: url.href,
            host: url.hostname,
            path: url.pathname + url.search,
            protocol: url.protocol.startsWith('https') ? 'HTTPS' : 'HTTP',
            client: 'Imported',
            requestHeaderEntries: e.request.headers,
            responseHeaderEntries: e.response.headers,
            state: e.response.status ? 'completed' : 'error',
            status: e.response.status,
            statusMessage: e.response.statusText,
            requestHeaders: Object.fromEntries(
                e.request.headers.map((h) => [h.name.toLowerCase(), h.value])
            ),
            responseHeaders: Object.fromEntries(
                e.response.headers.map((h) => [h.name.toLowerCase(), h.value])
            ),
            requestBody: e.request.postData?.text ?? '',
            responseBody: binary
                ? Buffer.from(e.response.content.text, 'base64').toString('utf8')
                : e.response.content.text,
            ...(binary ? { responseBase64: e.response.content.text } : {}),
            requestBytes: Math.max(0, e.request.bodySize),
            responseBytes: Math.max(0, e.response.content.size),
            duration: e.time,
            timings: e.timings
                ? timingSchema.parse({
                      ...Object.fromEntries(
                          Object.entries(e.timings).filter(([, value]) => value >= 0)
                      ),
                      total: e.time
                  })
                : undefined,
            ssl: url.protocol === 'https:',
            frames: [],
            pinned: false,
            saved: false,
            note: e.comment,
            highlight: e._fluxy?.highlight,
            requestBase64: e._fluxy?.requestBase64
        }
    })
}
