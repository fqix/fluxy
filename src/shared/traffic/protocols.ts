import { contentKind, pretty, type Transaction } from '../contracts/model'
export interface ProtocolPanel {
    title: string
    fields: Record<string, string>
    body: string
}
function object(input: unknown): Record<string, unknown> {
    return input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {}
}
function parse(input: string): unknown {
    try {
        return JSON.parse(input)
    } catch {
        return undefined
    }
}
function bodyBytes(text: string, base64?: string): Uint8Array | undefined {
    try {
        return base64
            ? Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
            : new TextEncoder().encode(text)
    } catch {
        return undefined
    }
}
// gRPC-Web carries grpc-status/grpc-message in a trailing 0x80 frame rather than in
// HTTP headers; only trailers-only responses put them in the header block.
export function grpcWebTrailers(t: Transaction): Record<string, string> {
    const type = t.responseHeaders['content-type'] ?? ''
    if (!/^application\/grpc-web(?:[+;\s]|$|-?text(?:[+;\s]|$))/i.test(type)) return {}
    let bytes = bodyBytes(t.responseBody, t.responseBase64)
    if (!bytes) return {}
    if (/^application\/grpc-web-?text/i.test(type)) {
        // grpc-web-text base64-encodes the frame stream itself.
        const inner = bodyBytes('', new TextDecoder().decode(bytes).replace(/\s+/g, ''))
        if (!inner) return {}
        bytes = inner
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let offset = 0; offset + 5 <= bytes.length;) {
        const flag = bytes[offset],
            length = view.getUint32(offset + 1)
        offset += 5
        if (offset + length > bytes.length) break
        if (flag === 0x80) {
            const block = new TextDecoder().decode(bytes.subarray(offset, offset + length))
            return Object.fromEntries(
                block.split(/\r\n/).flatMap((line) => {
                    const at = line.indexOf(':')
                    return at > 0
                        ? [
                              [
                                  line.slice(0, at).trim().toLowerCase(),
                                  line.slice(at + 1).trim()
                              ] as [string, string]
                          ]
                        : []
                })
            )
        }
        offset += length
    }
    return {}
}
export function protocolPanels(t: Transaction): ProtocolPanel[] {
    const request = object(parse(t.requestBody)),
        response = object(parse(t.responseBody))
    const panels: ProtocolPanel[] = []
    if (contentKind(t) === 'gRPC') {
        const parts = t.path.split('?')[0].split('/')
        const trailers = grpcWebTrailers(t)
        let message = trailers['grpc-message'] ?? t.responseHeaders['grpc-message'] ?? ''
        try {
            message = decodeURIComponent(message)
        } catch {
            /* Keep malformed metadata readable. */
        }
        panels.push({
            title: 'gRPC',
            fields: {
                Service: parts.at(-2) ?? '',
                Method: parts.at(-1) ?? '',
                'HTTP status': String(t.status ?? ''),
                'gRPC status':
                    trailers['grpc-status'] ?? t.responseHeaders['grpc-status'] ?? 'Not supplied',
                Message: message,
                Encoding: t.responseHeaders['grpc-encoding'] ?? 'identity'
            },
            body: 'Select a message type in Protobuf settings to decode the captured messages.'
        })
    }
    if (typeof request.query === 'string') {
        const operation = /^\s*(query|mutation|subscription)\s*(\w+)?/.exec(request.query)
        panels.push({
            title: 'GraphQL',
            fields: {
                Operation: String(request.operationName ?? operation?.[2] ?? 'Anonymous'),
                Type: operation?.[1] ?? 'query',
                Errors: Array.isArray(response.errors) ? String(response.errors.length) : '0'
            },
            body:
                request.query +
                '\n\nVariables\n' +
                JSON.stringify(request.variables ?? {}, null, 2) +
                '\n\nResponse\n' +
                pretty(t.responseBody)
        })
    }
    const rpc = parse(t.requestBody)
    const calls = (Array.isArray(rpc) ? rpc : [rpc]).map(object).filter((c) => c.jsonrpc === '2.0')
    if (calls.length)
        panels.push({
            title: 'Web3 RPC',
            fields: {
                Provider: t.host,
                Calls: String(calls.length),
                Methods: calls.map((c) => String(c.method)).join(', '),
                IDs: calls.map((c) => String(c.id ?? 'notification')).join(', '),
                Result: response.error
                    ? 'RPC error'
                    : t.status === 200
                      ? 'HTTP successful'
                      : 'Inspect response'
            },
            body: JSON.stringify(rpc, null, 2) + '\n\nResponse\n' + pretty(t.responseBody)
        })
    if (
        typeof request.model === 'string' ||
        /\/v1\/(chat\/completions|messages|responses)/.test(t.path)
    ) {
        const messages = Array.isArray(request.messages) ? request.messages : []
        panels.push({
            title: 'AI Model',
            fields: {
                Provider: t.host,
                Model: String(request.model ?? response.model ?? 'Unknown'),
                Streaming: String(request.stream ?? false),
                Messages: String(messages.length),
                Usage: JSON.stringify(response.usage ?? {}),
                Tools: Array.isArray(request.tools) ? String(request.tools.length) : '0'
            },
            body: JSON.stringify(
                { request, response: Object.keys(response).length ? response : t.responseBody },
                null,
                2
            )
        })
    }
    if (
        t.status === 402 ||
        t.responseHeaders['payment-required'] ||
        t.requestHeaders['payment-signature'] ||
        t.requestHeaders['x-payment']
    )
        panels.push({
            title: 'x402',
            fields: {
                Status: String(t.status),
                Challenge:
                    t.responseHeaders['payment-required'] ??
                    t.responseHeaders['x-payment-required'] ??
                    'See response body',
                Payment:
                    t.requestHeaders['payment-signature'] || t.requestHeaders['x-payment']
                        ? 'Payment proof present'
                        : 'No payment proof',
                Settlement: t.responseHeaders['payment-response'] ?? 'Not supplied'
            },
            body: pretty(t.responseBody)
        })
    return panels
}
