import type { Transaction } from './model'

type Schema = Record<string, unknown>
function schema(value: unknown, depth = 0): Schema {
    if (depth > 8) return {}
    if (value === null) return { nullable: true }
    if (Array.isArray(value))
        return { type: 'array', items: value.length ? schema(value[0], depth + 1) : {} }
    if (typeof value === 'object')
        return {
            type: 'object',
            properties: Object.fromEntries(
                Object.entries(value as object)
                    .slice(0, 200)
                    .map(([k, v]) => [k, schema(v, depth + 1)])
            )
        }
    return {
        type:
            typeof value === 'number'
                ? Number.isInteger(value)
                    ? 'integer'
                    : 'number'
                : typeof value === 'boolean'
                  ? 'boolean'
                  : 'string'
    }
}
function content(body: string, type: string) {
    let value: unknown = body
    if (/json/i.test(type)) {
        try {
            value = JSON.parse(body)
        } catch {
            /* Keep the captured text. */
        }
    }
    return { [type.split(';')[0].trim() || 'text/plain']: { schema: schema(value) } }
}
export function toOpenAPI(transactions: Transaction[]) {
    const paths: Record<string, Record<string, any>> = Object.create(null)
    const servers = new Set<string>()
    for (const t of transactions) {
        const url = new URL(t.url),
            method = t.method.toLowerCase()
        if (
            !/^https?:$/.test(url.protocol) ||
            !['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(method)
        )
            continue
        servers.add(url.origin)
        const path = (paths[url.pathname] ??= Object.create(null))
        const operation = (path[method] ??= {
            summary: `${t.method} ${url.pathname}`,
            servers: [],
            parameters: [],
            responses: Object.create(null)
        })
        if (!operation.servers.some((s: { url: string }) => s.url === url.origin))
            operation.servers.push({ url: url.origin })
        for (const name of new Set(url.searchParams.keys())) {
            if (!operation.parameters.some((p: { name: string }) => p.name === name))
                operation.parameters.push({
                    name,
                    in: 'query',
                    required: false,
                    schema: { type: 'string' }
                })
        }
        if (t.requestBody && !['get', 'head'].includes(method))
            operation.requestBody = {
                content: content(t.requestBody, t.requestHeaders['content-type'] || 'text/plain')
            }
        const status = t.status && t.status >= 100 ? String(t.status) : 'default'
        operation.responses[status] = {
            description:
                t.statusMessage || (status === 'default' ? 'Captured response' : `HTTP ${status}`),
            ...(t.responseBody
                ? {
                      content: content(
                          t.responseBody,
                          t.responseHeaders['content-type'] || 'text/plain'
                      )
                  }
                : {})
        }
    }
    if (!Object.keys(paths).length) throw new Error('Select at least one HTTP request to export')
    return {
        openapi: '3.0.3',
        info: {
            title: 'Fluxy Captured API',
            version: '1.0.0',
            description:
                'Inferred from observed traffic. Schemas describe samples, not the complete API contract. Captured credentials and body values are omitted.'
        },
        servers: [...servers].map((url) => ({ url })),
        paths
    }
}
export function toYAML(value: unknown, depth = 0): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    const entries = Object.entries(value)
    if (!entries.length) return Array.isArray(value) ? '[]' : '{}'
    return entries
        .map(([key, child]) => {
            const prefix =
                '  '.repeat(depth) + (Array.isArray(value) ? '-' : JSON.stringify(key) + ':')
            const nested =
                child !== null && typeof child === 'object' && Object.keys(child).length > 0
            return (
                prefix + (nested ? '\n' + toYAML(child, depth + 1) : ' ' + toYAML(child, depth + 1))
            )
        })
        .join('\n')
}
export function openAPIHTML(document: ReturnType<typeof toOpenAPI>) {
    const escape = (s: string) =>
        s.replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
        )
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Fluxy API Reference</title><style>body{font:16px system-ui;max-width:1000px;margin:48px auto;padding:0 24px}pre{overflow:auto;padding:20px;background:#f3f4f6;border-radius:8px}summary{cursor:pointer;padding:12px}details{border-bottom:1px solid #ddd}</style><h1>Fluxy API Reference</h1><p>${escape(document.info.description)}</p>${Object.entries(
        document.paths
    )
        .flatMap(([path, methods]) =>
            Object.entries(methods).map(
                ([method, operation]) =>
                    `<details><summary><strong>${escape(method.toUpperCase())}</strong> ${escape(path)}</summary><pre>${escape(JSON.stringify(operation, null, 2))}</pre></details>`
            )
        )
        .join('')}<h2>OpenAPI specification</h2><pre>${escape(toYAML(document))}</pre></html>`
}
