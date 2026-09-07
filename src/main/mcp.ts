import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { toCurl, type Transaction } from '../shared/model'
import { redactTransaction } from '../shared/redaction'
import type { ProxyEngine } from './proxy'
import type { Store } from './store'
const definitions = [
    ['get_version', 'Get the app and MCP versions', {}],
    ['get_proxy_status', 'Get proxy listener, recording and traffic count', {}],
    ['get_certificate_status', 'Get root certificate availability', {}],
    [
        'get_recent_flows',
        'Get recent flows, newest first',
        {
            limit: { type: 'integer', minimum: 1, maximum: 500 },
            filter_host: { type: 'string' },
            filter_method: { type: 'string' },
            filter_status_code: { type: 'integer' }
        }
    ],
    [
        'get_flow_detail',
        'Get headers, bounded body previews and timing',
        { flow_id: { type: 'string' } }
    ],
    [
        'search_flows',
        'Search captured URLs and filter by method/status',
        {
            query: { type: 'string' },
            method: { type: 'string' },
            status_min: { type: 'integer' },
            status_max: { type: 'integer' },
            limit: { type: 'integer', maximum: 500 }
        }
    ],
    [
        'filter_flows',
        'Filter with field/operator/value expressions',
        {
            filters: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        field: { type: 'string' },
                        operator: { type: 'string' },
                        value: { type: 'string' }
                    },
                    required: ['field', 'operator', 'value']
                }
            },
            combination: { type: 'string', enum: ['and', 'or'] }
        }
    ],
    ['export_flow_curl', 'Export one request as cURL', { flow_id: { type: 'string' } }],
    ['list_rules', 'List configured proxy rules', {}],
    ['get_ssl_proxying_list', 'List hosts included in HTTPS inspection', {}]
] as const
export class MCPService {
    private server?: http.Server
    readonly token: string
    constructor(
        private store: Store,
        private engine: ProxyEngine
    ) {
        const path = join(store.directory, 'mcp-token.json')
        this.token = existsSync(path)
            ? z
                  .string()
                  .regex(/^[a-f0-9]{64}$/)
                  .parse(JSON.parse(readFileSync(path, 'utf8')).token)
            : randomBytes(32).toString('hex')
        if (!existsSync(path)) store.write('mcp-token.json', { token: this.token })
    }
    private dispatch(name: string, raw: Record<string, unknown>) {
        const args = z
            .object({
                limit: z.number().int().min(1).max(500).default(50),
                filter_host: z.string().max(2000).optional(),
                filter_method: z.string().max(30).optional(),
                filter_status_code: z.number().int().optional(),
                flow_id: z.string().uuid().optional(),
                query: z.string().max(2000).optional(),
                method: z.string().max(30).optional(),
                status_min: z.number().optional(),
                status_max: z.number().optional(),
                combination: z.enum(['and', 'or']).default('and'),
                filters: z
                    .array(
                        z.object({
                            field: z.enum([
                                'host',
                                'method',
                                'status_code',
                                'path',
                                'client_app',
                                'state'
                            ]),
                            operator: z.enum([
                                'equals',
                                'not_equals',
                                'contains',
                                'starts_with',
                                'gt',
                                'lt'
                            ]),
                            value: z.string().max(2000)
                        })
                    )
                    .max(50)
                    .optional()
            })
            .parse(raw)
        const visible = (t: Transaction) =>
            this.store.settings.mcpRedact
                ? redactTransaction(t)
                : {
                      ...t,
                      requestBody: t.requestBody.slice(0, 32768),
                      responseBody: t.responseBody.slice(0, 32768),
                      responseBase64: undefined,
                      frames: t.frames.slice(-20)
                  }
        const all = [...this.engine.transactions.values()].reverse()
        const summary = (t: Transaction) => {
            const v = visible(t)
            return {
                id: v.id,
                timestamp: v.timestamp,
                method: v.method,
                url: v.url,
                status_code: v.status,
                state: v.state,
                duration: v.duration,
                client_app: v.client
            }
        }
        if (name === 'get_version')
            return { app: 'Fluxy', version: '0.1.0', protocolVersion: '2025-11-25' }
        if (name === 'get_proxy_status')
            return {
                running: this.engine.running,
                recording: this.engine.recording,
                port: this.store.settings.port,
                count: all.length
            }
        if (name === 'get_certificate_status')
            return {
                exists: existsSync(this.engine.certificatePath),
                path: this.engine.certificatePath,
                trust: 'Check platform trust store'
            }
        if (name === 'list_rules')
            return this.store.rules.map(({ value, ...rule }) => ({
                ...rule,
                value: this.store.settings.mcpRedact && value ? '[Value omitted]' : value
            }))
        if (name === 'get_ssl_proxying_list')
            return { enabled: this.store.settings.ssl, hosts: this.store.settings.sslHosts }
        if (name === 'get_flow_detail' || name === 'export_flow_curl') {
            const t = this.engine.transactions.get(args.flow_id ?? '')
            if (!t) throw new Error('Flow not found')
            return name === 'get_flow_detail' ? visible(t) : toCurl(visible(t))
        }
        if (name === 'get_recent_flows')
            return all
                .filter(
                    (t) =>
                        (!args.filter_host || t.host.includes(args.filter_host)) &&
                        (!args.filter_method || t.method === args.filter_method) &&
                        (args.filter_status_code === undefined ||
                            t.status === args.filter_status_code)
                )
                .slice(0, args.limit)
                .map(summary)
        if (name === 'search_flows')
            return all
                .filter(
                    (t) =>
                        (!args.query || t.url.toLowerCase().includes(args.query.toLowerCase())) &&
                        (!args.method || t.method === args.method) &&
                        (args.status_min === undefined || (t.status ?? 0) >= args.status_min) &&
                        (args.status_max === undefined || (t.status ?? 0) <= args.status_max)
                )
                .slice(0, args.limit)
                .map(summary)
        if (name === 'filter_flows') {
            const fields: Record<string, keyof Transaction> = {
                host: 'host',
                method: 'method',
                status_code: 'status',
                path: 'path',
                client_app: 'client',
                state: 'state'
            }
            return all
                .filter((t) => {
                    const checks = (args.filters ?? []).map((f) => {
                        const v = String(t[fields[f.field]] ?? '')
                        return f.operator === 'equals'
                            ? v === f.value
                            : f.operator === 'not_equals'
                              ? v !== f.value
                              : f.operator === 'contains'
                                ? v.includes(f.value)
                                : f.operator === 'starts_with'
                                  ? v.startsWith(f.value)
                                  : f.operator === 'gt'
                                    ? Number(v) > Number(f.value)
                                    : Number(v) < Number(f.value)
                    })
                    return args.combination === 'or' ? checks.some(Boolean) : checks.every(Boolean)
                })
                .slice(0, args.limit)
                .map(summary)
        }
        throw new Error('Unknown tool')
    }
    async start() {
        if (this.server) return
        const server = http.createServer(async (req, res) => {
            const token = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''))
            if (token.length !== 64 || !timingSafeEqual(token, Buffer.from(this.token))) {
                res.writeHead(401)
                res.end('Unauthorized')
                return
            }
            if (
                req.headers.origin ||
                ![
                    `127.0.0.1:${this.store.settings.mcpPort}`,
                    `localhost:${this.store.settings.mcpPort}`
                ].includes(req.headers.host ?? '')
            ) {
                res.writeHead(403)
                res.end('Forbidden origin or host')
                return
            }
            if (req.url !== '/mcp' || req.method !== 'POST') {
                res.writeHead(405)
                res.end()
                return
            }
            const chunks: Buffer[] = []
            let size = 0
            try {
                for await (const chunk of req) {
                    size += chunk.length
                    if (size > 1024 * 1024) {
                        res.writeHead(413)
                        res.end()
                        return
                    }
                    chunks.push(chunk)
                }
                const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                const mcp = new Server(
                    { name: 'fluxy', version: '0.1.0' },
                    { capabilities: { tools: {} } }
                )
                mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
                    tools: definitions.map(([name, description, properties]) => ({
                        name,
                        description,
                        inputSchema: { type: 'object' as const, properties },
                        annotations: {
                            readOnlyHint: true,
                            destructiveHint: false,
                            openWorldHint: false
                        }
                    }))
                }))
                mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
                    try {
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify(
                                        this.dispatch(
                                            request.params.name,
                                            request.params.arguments ?? {}
                                        )
                                    )
                                }
                            ]
                        }
                    } catch (error) {
                        return { isError: true, content: [{ type: 'text', text: String(error) }] }
                    }
                })
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: undefined,
                    enableJsonResponse: true
                })
                res.on('close', () => {
                    void transport.close()
                    void mcp.close()
                })
                await mcp.connect(transport)
                await transport.handleRequest(req, res, message)
            } catch {
                if (!res.headersSent) res.writeHead(400)
                res.end('Invalid request')
            }
        })
        server.requestTimeout = 15000
        server.headersTimeout = 10000
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(this.store.settings.mcpPort, '127.0.0.1', resolve)
        })
        this.server = server
        this.store.write('mcp-handshake.json', {
            port: this.store.settings.mcpPort,
            token: this.token
        })
        this.engine.log(
            `Read-only MCP server listening on 127.0.0.1:${this.store.settings.mcpPort}`
        )
    }
    async stop() {
        if (!this.server) return
        this.server.closeAllConnections()
        await new Promise<void>((r) => this.server!.close(() => r()))
        this.server = undefined
        const path = join(this.store.directory, 'mcp-handshake.json')
        if (existsSync(path)) unlinkSync(path)
    }
}
