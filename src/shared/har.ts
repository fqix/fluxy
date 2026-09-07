import { timingSchema } from './timing'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { frameSchema, highlightSchema, type Transaction } from './model'

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
                        ...(t.responseBase64 !== undefined ? { encoding: 'base64' } : {})
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
                    protocol: t.protocol,
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
                mimeType: z.string().max(1000).optional(),
                _encoding: z.literal('base64').optional(),
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
        _trailers: headerSchema,
        content: z
            .object({
                mimeType: z.string().max(1000).optional(),
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
    _webSocketMessages: z
        .array(
            z.object({
                type: z.enum(['send', 'receive']),
                time: z.number().finite().nonnegative().max(8640000000000),
                opcode: z.number().int().min(0).max(15),
                data: z.string().max(131072)
            })
        )
        .max(1000)
        .optional(),
    _fluxy: z
        .object({
            protocol: z.string().max(30).optional(),
            frames: z.array(frameSchema).max(1000).optional(),
            pinned: z.boolean().optional(),
            saved: z.boolean().optional(),
            truncated: z.boolean().optional(),
            error: z.string().max(100000).optional(),
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
        const requestHeaderEntries = [...e.request.headers]
        const responseHeaderEntries = [...e.response.headers]
        for (const trailer of e.response._trailers) {
            if (
                !responseHeaderEntries.some(
                    (h) =>
                        h.name.toLowerCase() === trailer.name.toLowerCase() &&
                        h.value === trailer.value
                )
            )
                responseHeaderEntries.push(trailer)
        }
        for (const [headers, mime] of [
            [requestHeaderEntries, e.request.postData?.mimeType],
            [responseHeaderEntries, e.response.content.mimeType]
        ] as const) {
            if (mime && !headers.some((h) => h.name.toLowerCase() === 'content-type'))
                headers.push({ name: 'Content-Type', value: mime })
        }
        const requestHeaders = Object.fromEntries(
            requestHeaderEntries.map((h) => [h.name.toLowerCase(), h.value])
        )
        const responseHeaders = Object.fromEntries(
            responseHeaderEntries.map((h) => [h.name.toLowerCase(), h.value])
        )
        const frames =
            e._fluxy?.frames ??
            e._webSocketMessages?.map((f) => ({
                id: randomUUID(),
                time: f.time * 1000,
                direction: f.type,
                body: f.data,
                binary: f.opcode === 2
            })) ??
            []
        const websocket =
            /^wss?:$/.test(url.protocol) ||
            frames.length > 0 ||
            e._fluxy?.protocol === 'WebSocket' ||
            (e.response.status === 101 && responseHeaders.upgrade?.toLowerCase() === 'websocket')
        const requestBase64 =
            e._fluxy?.requestBase64 ??
            (e.request.postData?._encoding === 'base64' ? e.request.postData.text : undefined)
        return {
            id: randomUUID(),
            sequence: i + 1,
            timestamp: Date.parse(e.startedDateTime),
            method: e.request.method,
            url: url.href,
            host: url.hostname,
            path: url.pathname + url.search,
            protocol: websocket ? 'WebSocket' : url.protocol === 'https:' ? 'HTTPS' : 'HTTP',
            client: 'Imported',
            requestHeaderEntries,
            responseHeaderEntries,
            state: e.response.status ? 'completed' : 'error',
            status: e.response.status,
            statusMessage: e.response.statusText,
            requestHeaders,
            responseHeaders,
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
            ssl: url.protocol === 'https:' || url.protocol === 'wss:',
            frames,
            pinned: e._fluxy?.pinned ?? false,
            saved: e._fluxy?.saved ?? false,
            truncated: e._fluxy?.truncated,
            error: e._fluxy?.error,
            note: e.comment,
            highlight: e._fluxy?.highlight,
            requestBase64
        }
    })
}
