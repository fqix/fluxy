import { timingSchema, type RequestTiming } from '../traffic/timing'
import type { UpdateState, UpdateAction } from '../app/updates'
import type { DiffResult, DiffTarget, DiffPair, DiffInput } from '../workspace/diff'
import type { ProjectCatalog, ProjectAction } from '../workspace/projects'
import type { MenuCommand, MenuState } from '../app/menu'
import { z } from 'zod'

export const highlightSchema = z
    .enum(['red', 'orange', 'yellow', 'green', 'blue', 'purple'])
    .nullable()
export type HighlightColor = z.infer<typeof highlightSchema>

export const captureDomainsSchema = z
    .array(
        z
            .string()
            .trim()
            .toLowerCase()
            .transform((value) => value.replace(/^\*\./, '').replace(/\.$/, ''))
            .pipe(
                z
                    .string()
                    .min(1)
                    .max(253)
                    .regex(
                        /^(?![0-9.]+$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
                        'Enter a domain such as example.com, without a URL, port or path'
                    )
            )
    )
    .max(100)
    .transform((domains) => [...new Set(domains)])
    .default([])

export const tunSettingsSchema = z.object({
    captureDomains: captureDomainsSchema,
    interface: z
        .string()
        .max(128)
        .regex(/^[\p{L}\p{N} ._()#-]*$/u, 'Invalid interface name')
        .default(''),
    socksPort: z
        .number()
        .int()
        .min(0)
        .max(65535)
        .refine((v) => v === 0 || v >= 1024)
        .default(0),
    routeCIDRs: z
        .array(z.union([z.cidrv4(), z.cidrv6()]))
        .max(128)
        .default([])
})
export type TunSettings = z.infer<typeof tunSettingsSchema>
export interface TunStatus {
    state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
    available: boolean
    interfaceName?: string
    splitDNS?: boolean
    error?: string
}
export const settingsSchema = z.object({
    updates: z
        .object({
            checkAutomatically: z.boolean().default(true),
            downloadAutomatically: z.boolean().default(false)
        })
        .default({ checkAutomatically: true, downloadAutomatically: false }),
    captureMode: z.enum(['proxy', 'tun']).default('tun'),
    tun: tunSettingsSchema.default({
        interface: '',
        socksPort: 0,
        routeCIDRs: [],
        captureDomains: []
    }),
    onboardingCompleted: z.boolean().default(false),
    showWelcomeOnLaunch: z.boolean().default(true),
    port: z.number().int().min(1024).max(65535).default(6060),
    localhostOnly: z.boolean().default(true),
    autoStart: z.boolean().default(false),
    autoSystemProxy: z.boolean().default(true),
    theme: z.enum(['system', 'light', 'dark']).default('system'),
    maxEntries: z.number().int().min(100).max(50000).default(10000),
    ssl: z.boolean().default(true),
    noCache: z.boolean().default(false),
    fullBypassHosts: z.array(z.string().min(1).max(255)).max(1000).default([]),
    previewTabs: z
        .array(z.enum(['JSON', 'Preview', 'Raw', 'Hex']))
        .max(4)
        .default(['JSON', 'Preview', 'Raw', 'Hex']),
    headerColumns: z
        .array(
            z.object({
                id: z.string().uuid(),
                name: z.string().trim().min(1).max(100),
                header: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
                source: z.enum(['request', 'response'])
            })
        )
        .max(20)
        .default([]),
    protobufSchemas: z
        .array(
            z.object({
                id: z.string().uuid(),
                name: z.string().min(1).max(100),
                source: z.string().min(1).max(500000)
            })
        )
        .max(50)
        .default([]),
    protobufType: z.string().max(500).default(''),
    fontSize: z.number().int().min(10).max(20).default(12),
    mcpEnabled: z.boolean().default(false),
    mcpPort: z.number().int().min(1024).max(65535).default(9710),
    mcpRedact: z.boolean().default(true),
    upstream: z
        .object({
            enabled: z.boolean().default(false),
            url: z.string().max(2000).default('http://127.0.0.1:8080'),
            bypass: z
                .array(z.string().max(255))
                .max(1000)
                .default(['localhost', '127.0.0.1', '::1'])
        })
        .default({
            enabled: false,
            url: 'http://127.0.0.1:8080',
            bypass: ['localhost', '127.0.0.1', '::1']
        }),
    sslHosts: z.array(z.string().max(255)).max(1000).default(['*'])
})
export type Settings = z.infer<typeof settingsSchema>
export const ruleKinds = [
    'block',
    'allow',
    'mapLocal',
    'mapRemote',
    'requestHeader',
    'responseHeader',
    'throttle',
    'networkCondition',
    'breakpoint'
] as const
export const ruleSchema = z.object({
    id: z.string().uuid(),
    name: z.string().min(1).max(200),
    enabled: z.boolean(),
    kind: z.enum(ruleKinds),
    pattern: z.string().min(1).max(2000),
    matchType: z.enum(['legacy', 'wildcard', 'regex']).optional(),
    includeSubpaths: z.boolean().optional(),
    matchHeaderName: z.string().max(200).optional(),
    matchHeaderValue: z.string().max(10000).optional(),
    method: z.string().max(20).default('*'),
    value: z
        .string()
        .max(2 * 1024 * 1024)
        .default(''),
    header: z.string().max(200).default(''),
    status: z.number().int().min(100).max(599).default(200),
    delay: z.number().int().min(0).max(30000).default(1000),
    networkPreset: z.enum(['threeG', 'edge', 'lte', 'veryBadNetwork', 'wifi', 'custom']).optional(),
    phase: z.enum(['request', 'response', 'both']).default('request'),
    uploadKbps: z.number().int().min(0).max(1000000).default(0),
    downloadKbps: z.number().int().min(0).max(1000000).default(0)
})
export type Rule = z.infer<typeof ruleSchema>
export const composeSchema = z.object({
    url: z
        .string()
        .url()
        .max(16000)
        .refine((s) => /^https?:\/\//.test(s), 'Use an HTTP or HTTPS URL'),
    method: z
        .string()
        .min(1)
        .max(32)
        .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
    headers: z.record(
        z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
        z.string().refine((s) => !/[\0\r\n]/.test(s))
    ),
    body: z
        .string()
        .max(2 * 1024 * 1024)
        .default('')
})
export const headerEntriesSchema = z
    .array(
        z.object({
            name: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
            value: z.string().refine((s) => !/[\0\r\n]/.test(s))
        })
    )
    .max(5000)
export const requestEditSchema = composeSchema.extend({
    headerEntries: headerEntriesSchema.optional(),
    preserveBody: z.boolean().optional()
})
export const responseEditSchema = z.object({
    headerEntries: headerEntriesSchema.optional(),
    preserveBody: z.boolean().optional(),
    status: z.number().int().min(200).max(599),
    headers: composeSchema.shape.headers,
    body: composeSchema.shape.body
})
export const breakpointEditSchema = z.union([requestEditSchema, responseEditSchema])
export type BreakpointEdit = z.infer<typeof breakpointEditSchema>
export const breakpointTemplateSchema = z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    phase: z.enum(['request', 'response']),
    message: z.string().max(2 * 1024 * 1024)
})
export type BreakpointTemplate = z.infer<typeof breakpointTemplateSchema>
export const scriptSchema = z.object({
    id: z.string().uuid(),
    name: z.string().min(1).max(200),
    enabled: z.boolean(),
    pattern: z.string().min(1).max(2000),
    matchType: z.enum(['legacy', 'wildcard', 'regex']).optional(),
    includeSubpaths: z.boolean().optional(),
    matchHeaderName: z.string().max(200).optional(),
    matchHeaderValue: z.string().max(10000).optional(),
    phase: z.enum(['request', 'response']),
    code: z.string().max(100000)
})
export type Script = z.infer<typeof scriptSchema>
export interface ScriptMessage {
    url: string
    method: ComposeRequest['method']
    headers: Headers
    body: string
    status?: number
}
export type ComposeRequest = z.infer<typeof composeSchema>
export type Headers = Record<string, string>
export const frameSchema = z.object({
    id: z.string().uuid(),
    time: z.number().finite(),
    direction: z.enum(['send', 'receive']),
    body: z.string().max(131072),
    binary: z.boolean()
})
export interface Frame {
    id: string
    time: number
    direction: 'send' | 'receive'
    body: string
    binary: boolean
}
export interface Transaction {
    id: string
    sequence: number
    timestamp: number
    method: string
    url: string
    host: string
    path: string
    protocol: string
    httpVersion?: string
    responseTrailers?: Headers
    client: string
    clientPID?: number
    clientIdentity?: string
    clientSource?: 'process' | 'user-agent' | 'remote' | 'composer' | 'unknown'
    requestHeaderEntries?: { name: string; value: string }[]
    responseHeaderEntries?: { name: string; value: string }[]
    state: 'pending' | 'paused' | 'completed' | 'error' | 'blocked'
    status?: number
    statusMessage?: string
    requestHeaders: Headers
    responseHeaders: Headers
    requestBody: string
    responseBody: string
    requestBytes: number
    responseBytes: number
    duration: number
    timings?: RequestTiming
    ssl: boolean
    error?: string
    rule?: string
    frames: Frame[]
    pinned: boolean
    saved: boolean
    note: string
    breakpointPhase?: 'request' | 'response'
    breakpointBodyEditable?: boolean
    breakpointRuleName?: string
    highlight?: HighlightColor
    truncated?: boolean
    requestBase64?: string
    responseBase64?: string
}
export interface LogEntry {
    id: string
    timestamp: number
    level: 'info' | 'error' | 'warn'
    message: string
}
export interface SessionSummary {
    id: string
    name: string
    createdAt: number
    count: number
}
export interface HelperStatus {
    state:
        'missing' | 'installing' | 'uninstalling' | 'ready' | 'outdated' | 'error' | 'unsupported'
    version?: string
    error?: string
}
export interface CustomCertificateSummary {
    id: string
    name: string
    kind: 'root' | 'server' | 'client'
    host: string
    fingerprint: string
    expires: string
}
export interface Snapshot {
    update: UpdateState
    customCertificates: CustomCertificateSummary[]
    customCertificateError?: string
    projectsInitialized: boolean
    templates: BreakpointTemplate[]
    projects: ProjectCatalog
    projectError?: string
    helper: HelperStatus
    tun: TunStatus
    networkInterfaces: string[]
    settings: Settings
    rules: Rule[]
    scripts: Script[]
    transactions: Transaction[]
    favorites: Transaction[]
    running: boolean
    recording: boolean
    logs: LogEntry[]
    sessions: SessionSummary[]
    certificatePath: string
    systemProxy: boolean
    mcpConfig: string
}
export type AppEvent =
    | { type: 'transaction'; transaction: Transaction }
    | { type: 'state' }
    | { type: 'log'; log: LogEntry }
    | { type: 'command'; command: MenuCommand }
export interface CertificateStatus {
    browserError?: string
    generated: boolean
    trusted: boolean
    supported: boolean
    error?: string
}
export interface FluxyAPI {
    platform: string
    diffText(left: string, right: string): Promise<DiffResult>
    diffHistory(): Promise<DiffPair[]>
    diffRecord(left: string, right: string): Promise<DiffPair[]>
    diffHistoryChange(
        id: string,
        patch: { pinned?: boolean; name?: string; remove?: boolean }
    ): Promise<DiffPair[]>
    diffSaved(id: string, target: DiffTarget): Promise<DiffResult>
    diffExport(input: DiffInput): Promise<string | null>
    update(action: UpdateAction): Promise<void>
    diff(left: string, right: string, target: DiffTarget): Promise<DiffResult>
    importCustomCertificate(input: {
        name: string
        kind: 'root' | 'server' | 'client'
        host: string
        password: string
    }): Promise<void>
    deleteCustomCertificate(id: string): Promise<void>
    protobufTypes(): Promise<string[]>
    decodeProtobuf(id: string, side: 'request' | 'response', type: string): Promise<unknown>
    gistReview(ids: string[]): Promise<{ id: string; content: string }>
    gistPublish(input: {
        reviewID: string
        token: string
        description: string
        public: boolean
    }): Promise<string>
    project(action: ProjectAction): Promise<ProjectCatalog>
    exportProject(id: string): Promise<string | null>
    importProject(): Promise<ProjectCatalog | null>
    exportOpenAPI(format: 'yaml' | 'html', ids: string[]): Promise<string | null>
    deleteTransactions(ids: string[]): Promise<void>
    prepareTerminal(mode: 'copy' | 'open'): Promise<string>
    debugInfo(): Promise<string>
    openLink(link: 'homepage' | 'repository' | 'docs' | 'issues' | 'changelog'): Promise<void>
    exportCertificateFormat(
        format: 'pem' | 'der' | 'key' | 'p12',
        password?: string
    ): Promise<string | null>
    templates(value: BreakpointTemplate[]): Promise<void>
    shortcuts(): Promise<{ label: string; accelerator: string }[]>
    menuState(state: MenuState): Promise<void>
    resetCertificates(): Promise<boolean>
    resetHelper(): Promise<boolean>
    helperStatus(): Promise<HelperStatus>
    installHelper(): Promise<void>
    uninstallHelper(): Promise<boolean>
    certificateStatus(): Promise<CertificateStatus>
    generateCertificate(): Promise<CertificateStatus>
    snapshot(): Promise<Snapshot>
    start(): Promise<void>
    stop(): Promise<void>
    record(value: boolean): Promise<void>
    clear(): Promise<void>
    settings(value: Settings): Promise<void>
    rules(value: Rule[]): Promise<void>
    scripts(value: Script[]): Promise<void>
    compose(value: ComposeRequest): Promise<Transaction>
    updateTransaction(
        id: string,
        value: { pinned?: boolean; saved?: boolean; note?: string; highlight?: HighlightColor }
    ): Promise<void>
    applyBreakpoints(edits: { id: string; edit: BreakpointEdit }[]): Promise<void>
    breakpoints(action: 'continue' | 'abort'): Promise<void>
    breakpoint(id: string, action: 'continue' | 'abort', edit?: BreakpointEdit): Promise<void>
    saveSession(name: string): Promise<void>
    loadSession(id: string): Promise<void>
    deleteSession(id: string): Promise<void>
    exportHAR(ids?: string[]): Promise<string | null>
    importHAR(): Promise<void>
    exportCertificate(): Promise<string | null>
    trustCertificate(): Promise<boolean>
    systemProxy(enabled: boolean): Promise<void>
    chooseFile(): Promise<string | null>
    copy(text: string): Promise<void>
    onEvent(listener: (event: AppEvent) => void): () => void
}

export function matchPattern(pattern: string, value: string): boolean {
    // Greedy wildcard matching avoids regular-expression backtracking on user globs.
    const patternLower = pattern.toLowerCase(),
        text = value.toLowerCase()
    let p = 0,
        v = 0,
        star = -1,
        matched = 0
    while (v < text.length) {
        if (patternLower[p] === text[v]) {
            p++
            v++
        } else if (patternLower[p] === '*') {
            star = p++
            matched = v
        } else if (star >= 0) {
            p = star + 1
            v = ++matched
        } else return false
    }
    while (patternLower[p] === '*') p++
    return p === patternLower.length
}
export function matchesRule(rule: Rule, method: string, url: string): boolean {
    return (
        rule.enabled &&
        (rule.method === '*' || rule.method === method) &&
        matchPattern(rule.pattern, url)
    )
}
export function contentKind(t: Transaction): string {
    if (t.frames.length || t.protocol === 'WebSocket') return 'WebSocket'
    if (
        [t.requestHeaders['content-type'], t.responseHeaders['content-type']].some((ct) =>
            /^application\/grpc(?:[+;\s]|$|-web(?:[+;\s]|$|-?text(?:[+;\s]|$)))/i.test(ct ?? '')
        )
    )
        return 'gRPC'
    if (/graphql/i.test(t.path) || /"query"\s*:/.test(t.requestBody)) return 'GraphQL'
    const ct = t.responseHeaders['content-type'] ?? ''
    if (ct.includes('json')) return 'JSON'
    if (ct.includes('xml')) return 'XML'
    if (ct.includes('javascript')) return 'JS'
    if (ct.includes('css')) return 'CSS'
    if (ct.includes('html')) return 'Document'
    if (/image|video|audio/.test(ct)) return 'Media'
    if (ct.includes('font')) return 'Font'
    if ((t.requestHeaders['content-type'] ?? '').includes('form')) return 'Form'
    return 'Other'
}
export function toCurl(
    t: Pick<Transaction, 'method' | 'url' | 'requestHeaders' | 'requestBody'>
): string {
    const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
    return [
        'curl',
        '-X',
        t.method,
        quote(t.url),
        ...Object.entries(t.requestHeaders)
            .filter(([k]) => !['host', 'content-length', 'connection'].includes(k.toLowerCase()))
            .flatMap(([k, v]) => ['-H', quote(`${k}: ${v}`)]),
        ...(t.requestBody ? ['--data-raw', quote(t.requestBody)] : [])
    ].join(' ')
}
export function pretty(text: string): string {
    try {
        return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
        return text
    }
}
export function bytes(n: number): string {
    return n < 1024
        ? `${n} B`
        : n < 1048576
          ? `${(n / 1024).toFixed(1)} KB`
          : `${(n / 1048576).toFixed(1)} MB`
}

export const transactionSchema: z.ZodType<Transaction> = z.object({
    id: z.string().uuid(),
    sequence: z.number().int().min(0),
    timestamp: z.number(),
    method: z.string().max(30),
    url: z
        .string()
        .url()
        .refine((s) => /^(https?|wss?):\/\//.test(s)),
    host: z.string().max(2000),
    path: z.string().max(32000),
    protocol: z.string().max(30),
    httpVersion: z.string().max(20).optional(),
    responseTrailers: z.record(z.string(), z.string()).optional(),
    client: z.string().max(1000),
    clientPID: z.number().int().positive().optional(),
    clientIdentity: z.string().max(2000).optional(),
    clientSource: z.enum(['process', 'user-agent', 'remote', 'composer', 'unknown']).optional(),
    requestHeaderEntries: z
        .array(z.object({ name: z.string(), value: z.string() }))
        .max(5000)
        .optional(),
    responseHeaderEntries: z
        .array(z.object({ name: z.string(), value: z.string() }))
        .max(5000)
        .optional(),
    state: z.enum(['pending', 'paused', 'completed', 'error', 'blocked']),
    status: z.number().int().min(0).max(599).optional(),
    statusMessage: z.string().max(1000).optional(),
    requestHeaders: z.record(z.string(), z.string()),
    responseHeaders: z.record(z.string(), z.string()),
    requestBody: z.string().max(8 * 1024 * 1024),
    responseBody: z.string().max(8 * 1024 * 1024),
    requestBytes: z.number().min(0),
    responseBytes: z.number().min(0),
    timings: timingSchema.optional(),
    duration: z.number().min(0),
    ssl: z.boolean(),
    error: z.string().optional(),
    rule: z.string().optional(),
    frames: z.array(frameSchema).max(1000),
    pinned: z.boolean(),
    saved: z.boolean(),
    note: z.string().max(100000),
    highlight: highlightSchema.optional(),
    breakpointPhase: z.enum(['request', 'response']).optional(),
    breakpointBodyEditable: z.boolean().optional(),
    breakpointRuleName: z.string().max(200).optional(),
    truncated: z.boolean().optional(),
    requestBase64: z
        .string()
        .max(4 * 1024 * 1024)
        .optional(),
    responseBase64: z
        .string()
        .max(4 * 1024 * 1024)
        .optional()
})
