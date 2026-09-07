import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { HeaderTable } from '@/components/data/HeaderTable'
import type { Run } from '@/types/actions'
import { setupInstructions } from '@shared/app/setup'
import { useState } from 'react'
import {
    Plus,
    Trash2,
    FolderOpen,
    Send,
    Copy,
    Download,
    ShieldCheck,
    Settings2,
    Code2
} from 'lucide-react'
import {
    ruleSchema,
    type Rule,
    type Snapshot,
    type Transaction,
    type ComposeRequest,
    pretty
} from '@shared/contracts/model'

export const ruleNames: Record<Rule['kind'], string> = {
    block: 'Block List',
    allow: 'Allow List',
    mapLocal: 'Map Local',
    mapRemote: 'Map Remote',
    requestHeader: 'Modify Headers',
    responseHeader: 'Modify Headers',
    throttle: 'Throttle',
    networkCondition: 'Network Conditions',
    breakpoint: 'Breakpoint'
}

export function RuleEditor({
    initialID,
    title,
    snapshot,
    run
}: {
    initialID?: string
    title: string
    snapshot: Snapshot
    run: Run
}) {
    const [rules, setRules] = useState(snapshot.rules)
    const [selected, setSelected] = useState<string | undefined>(initialID)
    const visible = rules.filter((r) => ruleNames[r.kind] === title)
    const current = rules.find((r) => r.id === selected)
    const update = (patch: Partial<Rule>) =>
        setRules((old) => old.map((r) => (r.id === selected ? { ...r, ...patch } : r)))
    const add = () => {
        const kind = (Object.keys(ruleNames) as Rule['kind'][]).find((k) => ruleNames[k] === title)!
        const rule = ruleSchema.parse({
            id: crypto.randomUUID(),
            name: `New ${title} Rule`,
            kind,
            enabled: true,
            pattern: 'https://example.com/*',
            ...(kind === 'breakpoint' ? { matchType: 'wildcard', includeSubpaths: true } : {})
        })
        setRules([...rules, rule])
        setSelected(rule.id)
    }
    return (
        <>
            <div className="rule-layout">
                <aside className="rule-list">
                    <div className="section-label">{visible.length} RULES</div>
                    {visible.map((rule) => (
                        <Button
                            key={rule.id}
                            className={selected === rule.id ? 'selected' : ''}
                            onClick={() => setSelected(rule.id)}
                        >
                            <span className={rule.enabled ? 'green' : 'muted'}>●</span>
                            <span>
                                {rule.name}
                                <small>{rule.pattern}</small>
                            </span>
                        </Button>
                    ))}
                    <Button onClick={add}>
                        <Plus size={14} /> Add Rule
                    </Button>
                </aside>
                <div className="rule-form">
                    {current ? (
                        <>
                            <label className="check">
                                <input
                                    type="checkbox"
                                    checked={current.enabled}
                                    onChange={(e) => update({ enabled: e.target.checked })}
                                />
                                Enable rule
                            </label>
                            <label>
                                Name
                                <Input
                                    value={current.name}
                                    onChange={(e) => update({ name: e.target.value })}
                                />
                            </label>
                            <label>
                                URL pattern
                                <Input
                                    aria-label="URL pattern"
                                    value={current.pattern}
                                    onChange={(e) => update({ pattern: e.target.value })}
                                />
                                <small>Use * to match any sequence of characters.</small>
                            </label>
                            {current.kind === 'throttle' && (
                                <>
                                    <label>
                                        Upload (kbit/s; 0 is unlimited)
                                        <Input
                                            aria-label="Upload bandwidth"
                                            type="number"
                                            min={0}
                                            max={1000000}
                                            value={current.uploadKbps}
                                            onChange={(e) =>
                                                update({ uploadKbps: Number(e.target.value) })
                                            }
                                        />
                                    </label>
                                    <label>
                                        Download (kbit/s; 0 is unlimited)
                                        <Input
                                            aria-label="Download bandwidth"
                                            type="number"
                                            min={0}
                                            max={1000000}
                                            value={current.downloadKbps}
                                            onChange={(e) =>
                                                update({ downloadKbps: Number(e.target.value) })
                                            }
                                        />
                                    </label>
                                </>
                            )}
                            {current.kind === 'breakpoint' && (
                                <>
                                    <label>
                                        URL match type
                                        <select
                                            aria-label="Breakpoint match type"
                                            value={current.matchType ?? 'legacy'}
                                            onChange={(e) =>
                                                update({
                                                    matchType: e.target.value as Rule['matchType']
                                                })
                                            }
                                        >
                                            <option value="legacy">
                                                Legacy wildcard (whole URL)
                                            </option>
                                            <option value="wildcard">Wildcard</option>
                                            <option value="regex">Regular expression</option>
                                        </select>
                                    </label>
                                    {current.matchType === 'wildcard' && (
                                        <label className="check">
                                            <input
                                                type="checkbox"
                                                checked={current.includeSubpaths ?? false}
                                                onChange={(e) =>
                                                    update({ includeSubpaths: e.target.checked })
                                                }
                                            />
                                            Include subpaths
                                        </label>
                                    )}
                                    <label>
                                        Match header name
                                        <Input
                                            aria-label="Breakpoint match header"
                                            value={current.matchHeaderName ?? ''}
                                            onChange={(e) =>
                                                update({ matchHeaderName: e.target.value })
                                            }
                                        />
                                    </label>
                                    <label>
                                        Match header value (exact; empty means any)
                                        <Input
                                            aria-label="Breakpoint match header value"
                                            value={current.matchHeaderValue ?? ''}
                                            onChange={(e) =>
                                                update({ matchHeaderValue: e.target.value })
                                            }
                                        />
                                    </label>
                                </>
                            )}
                            {current.kind === 'breakpoint' && (
                                <label>
                                    Breakpoint phase
                                    <select
                                        aria-label="Breakpoint phase"
                                        value={current.phase}
                                        onChange={(e) =>
                                            update({ phase: e.target.value as Rule['phase'] })
                                        }
                                    >
                                        <option value="request">Request</option>
                                        <option value="response">Response</option>
                                        <option value="both">Request and response</option>
                                    </select>
                                </label>
                            )}
                            <label>
                                Method
                                <select
                                    value={current.method}
                                    onChange={(e) => update({ method: e.target.value })}
                                >
                                    {[
                                        '*',
                                        'GET',
                                        'POST',
                                        'PUT',
                                        'PATCH',
                                        'DELETE',
                                        'HEAD',
                                        'OPTIONS'
                                    ].map((m) => (
                                        <option key={m}>{m}</option>
                                    ))}
                                </select>
                            </label>
                            {current.kind === 'mapLocal' && (
                                <>
                                    <label>
                                        Local response file
                                        <div className="inline-input">
                                            <Input
                                                value={current.value}
                                                onChange={(e) => update({ value: e.target.value })}
                                            />
                                            <Button
                                                title="Choose response file"
                                                onClick={() =>
                                                    void run(async () => {
                                                        const file = await window.fluxy.chooseFile()
                                                        if (file) update({ value: file })
                                                    })
                                                }
                                            >
                                                <FolderOpen size={16} />
                                            </Button>
                                        </div>
                                    </label>
                                    <label>
                                        Content type
                                        <Input
                                            value={current.header}
                                            placeholder="application/json"
                                            onChange={(e) => update({ header: e.target.value })}
                                        />
                                    </label>
                                    <label>
                                        Status code
                                        <Input
                                            type="number"
                                            min="100"
                                            max="599"
                                            value={current.status}
                                            onChange={(e) =>
                                                update({ status: Number(e.target.value) })
                                            }
                                        />
                                    </label>
                                </>
                            )}
                            {current.kind === 'mapRemote' && (
                                <label>
                                    Destination URL
                                    <Input
                                        value={current.value}
                                        placeholder="https://staging.example.com/api"
                                        onChange={(e) => update({ value: e.target.value })}
                                    />
                                </label>
                            )}
                            {['requestHeader', 'responseHeader'].includes(current.kind) && (
                                <>
                                    <label>
                                        Direction
                                        <select
                                            value={current.kind}
                                            onChange={(e) =>
                                                update({ kind: e.target.value as Rule['kind'] })
                                            }
                                        >
                                            <option value="requestHeader">Request</option>
                                            <option value="responseHeader">Response</option>
                                        </select>
                                    </label>
                                    <label>
                                        Header name
                                        <Input
                                            value={current.header}
                                            onChange={(e) => update({ header: e.target.value })}
                                        />
                                    </label>
                                    <label>
                                        Value
                                        <Input
                                            value={current.value}
                                            onChange={(e) => update({ value: e.target.value })}
                                        />
                                        <small>Leave empty to remove this header.</small>
                                    </label>
                                </>
                            )}
                            {current.kind === 'throttle' && (
                                <label>
                                    Delay (milliseconds)
                                    <Input
                                        type="number"
                                        min="0"
                                        max="30000"
                                        value={current.delay}
                                        onChange={(e) => update({ delay: Number(e.target.value) })}
                                    />
                                </label>
                            )}
                            {current.kind === 'breakpoint' && (
                                <p className="muted">
                                    Matching requests pause before forwarding. Continue or abort
                                    them in the breakpoint queue. Drafts are retained when switching
                                    messages.
                                </p>
                            )}
                            {current.kind === 'allow' && (
                                <p className="muted">
                                    While any Allow List rule is enabled, requests must match an
                                    enabled Allow List rule to be forwarded.
                                </p>
                            )}
                            <Button
                                className="danger"
                                onClick={() => {
                                    setRules(rules.filter((r) => r.id !== current.id))
                                    setSelected(undefined)
                                }}
                            >
                                <Trash2 size={14} /> Delete Rule
                            </Button>
                        </>
                    ) : (
                        <div className="subtle-empty">
                            <Settings2 size={32} />
                            <h3>{title}</h3>
                            <p>Create a rule to control matching traffic.</p>
                            <Button className="primary" onClick={add}>
                                <Plus size={14} />
                                Add Rule
                            </Button>
                        </div>
                    )}
                </div>
            </div>
            <footer className="modal-footer">
                <span className="muted">Rules apply to subsequent requests.</span>
                <Button
                    className="primary"
                    onClick={() => void run(() => window.fluxy.rules(rules), 'Rules saved')}
                >
                    Save Rules
                </Button>
            </footer>
        </>
    )
}
export function Composer({ transaction, run }: { transaction?: Transaction; run: Run }) {
    const [method, setMethod] = useState(
        transaction?.method === 'CONNECT' ? 'GET' : (transaction?.method ?? 'GET')
    )
    const [url, setURL] = useState(transaction?.url ?? 'https://example.com')
    const [headers, setHeaders] = useState(
        Object.entries(transaction?.requestHeaders ?? {})
            .filter(([k]) => !['host', 'content-length', 'connection'].includes(k))
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n')
    )
    const [body, setBody] = useState(transaction?.requestBody ?? '')
    const [response, setResponse] = useState<Transaction>()
    const [sending, setSending] = useState(false)
    const send = async () => {
        setSending(true)
        await run(async () => {
            const h = Object.fromEntries(
                headers
                    .split('\n')
                    .filter((l) => l.trim())
                    .map((line) => {
                        const i = line.indexOf(':')
                        if (i < 1) throw new Error('Each header must use Name: Value')
                        return [line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]
                    })
            )
            setResponse(
                await window.fluxy.compose({
                    method: method as ComposeRequest['method'],
                    url,
                    headers: h,
                    body
                })
            )
        })
        setSending(false)
    }
    return (
        <div className="composer">
            <div className="compose-url">
                <select
                    aria-label="HTTP method"
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                >
                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => (
                        <option key={m}>{m}</option>
                    ))}
                </select>
                <Input
                    aria-label="Request URL"
                    value={url}
                    onChange={(e) => setURL(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') void send()
                    }}
                />
                <Button className="primary" disabled={sending} onClick={() => void send()}>
                    <Send size={14} />
                    {sending ? 'Sending…' : 'Send'}
                </Button>
            </div>
            <div className="compose-fields">
                <label>
                    Headers
                    <Textarea
                        spellCheck={false}
                        value={headers}
                        placeholder="Content-Type: application/json"
                        onChange={(e) => setHeaders(e.target.value)}
                    />
                </label>
                <label>
                    Body
                    <Textarea
                        spellCheck={false}
                        value={body}
                        placeholder="Request body"
                        onChange={(e) => setBody(e.target.value)}
                    />
                </label>
            </div>
            <div className="compose-response">
                <h4>
                    Response{' '}
                    {response && (
                        <>
                            <span className={Number(response.status) >= 400 ? 'orange' : 'green'}>
                                {response.status} {response.statusMessage}
                            </span>
                            <span className="muted">{response.duration} ms</span>
                        </>
                    )}
                </h4>
                {response ? (
                    <>
                        {response.error && <div className="error-banner">{response.error}</div>}
                        <pre>{pretty(response.responseBody)}</pre>
                    </>
                ) : (
                    <div className="subtle-empty">Send a request to see the response.</div>
                )}
            </div>
        </div>
    )
}
export function Preferences({
    snapshot,
    run,
    ssl = false
}: {
    snapshot: Snapshot
    run: Run
    ssl?: boolean
}) {
    const [settings, setSettings] = useState(snapshot.settings)
    const patch = (v: Partial<typeof settings>) => setSettings((s) => ({ ...s, ...v }))
    return (
        <>
            <div className="settings-form">
                {ssl ? (
                    <>
                        <h3>SSL Proxying</h3>
                        <p>Decrypt HTTPS requests using the local Fluxy Electron certificate.</p>
                        <label className="check">
                            <input
                                type="checkbox"
                                checked={settings.ssl}
                                onChange={(e) => patch({ ssl: e.target.checked })}
                            />
                            Enable SSL proxying
                        </label>
                        <label>
                            Included hosts
                            <Textarea
                                value={settings.sslHosts.join('\n')}
                                onChange={(e) =>
                                    patch({ sslHosts: e.target.value.split('\n').filter(Boolean) })
                                }
                            />
                            <small>
                                One host per line. * matches every host. Other hosts use encrypted
                                CONNECT tunnels.
                            </small>
                        </label>
                    </>
                ) : (
                    <>
                        <h3>General</h3>
                        <label>
                            Proxy port
                            <Input
                                type="number"
                                min="1024"
                                max="65535"
                                value={settings.port}
                                onChange={(e) => patch({ port: Number(e.target.value) })}
                            />
                            <small>Stop the proxy before changing its port.</small>
                        </label>
                        <label className="check">
                            <input
                                type="checkbox"
                                checked={settings.localhostOnly}
                                onChange={(e) => patch({ localhostOnly: e.target.checked })}
                            />
                            Listen on localhost only
                        </label>
                        <label className="check">
                            <input
                                type="checkbox"
                                checked={settings.autoStart}
                                onChange={(e) => patch({ autoStart: e.target.checked })}
                            />
                            Start proxy on launch
                        </label>
                        <label className="check">
                            <input
                                type="checkbox"
                                checked={settings.noCache}
                                onChange={(e) => patch({ noCache: e.target.checked })}
                            />
                            Disable HTTP caching
                        </label>
                        <h3>Appearance</h3>
                        <label>
                            Theme
                            <select
                                value={settings.theme}
                                onChange={(e) =>
                                    patch({ theme: e.target.value as typeof settings.theme })
                                }
                            >
                                <option value="system">System</option>
                                <option value="light">Light</option>
                                <option value="dark">Dark</option>
                            </select>
                        </label>
                        <label>
                            Font size
                            <Input
                                type="number"
                                min="10"
                                max="20"
                                value={settings.fontSize}
                                onChange={(e) => patch({ fontSize: Number(e.target.value) })}
                            />
                        </label>
                        <label>
                            Maximum captured requests
                            <Input
                                type="number"
                                min="100"
                                max="50000"
                                value={settings.maxEntries}
                                onChange={(e) => patch({ maxEntries: Number(e.target.value) })}
                            />
                        </label>
                    </>
                )}
            </div>
            <footer className="modal-footer">
                <span className="muted">Preferences are saved on this device.</span>
                <Button
                    className="primary"
                    onClick={() =>
                        void run(() => window.fluxy.settings(settings), 'Settings saved')
                    }
                >
                    Save Settings
                </Button>
            </footer>
        </>
    )
}
export function Certificates({ snapshot, run }: { snapshot: Snapshot; run: Run }) {
    return (
        <div className="certificate-panel">
            <ShieldCheck size={48} className="blue" />
            <h2>Fluxy Electron Root CA</h2>
            <p>
                Install and trust this certificate to inspect HTTPS traffic.
                <br />
                Fluxy keeps the same certificate across restarts. Helper Tool handles System
                keychain trust after a single installation authorization.
            </p>
            <HeaderTable
                values={{
                    Certificate: snapshot.certificatePath,
                    Scope: 'Independent from the Swift Fluxy certificate',
                    Usage: 'Local development and traffic inspection'
                }}
            />
            <div className="button-row">
                <Button
                    onClick={() =>
                        void run(
                            () => window.fluxy.exportCertificate(),
                            'Certificate export finished'
                        )
                    }
                >
                    <Download size={14} />
                    Export Certificate
                </Button>
                <Button
                    className="primary"
                    onClick={() => void run(() => window.fluxy.trustCertificate())}
                >
                    <ShieldCheck size={14} />
                    Install & Trust on macOS
                </Button>
            </div>
            <p className="muted">
                For iOS: export the certificate, install its profile, then enable full trust under
                Settings → General → About → Certificate Trust Settings.
            </p>
        </div>
    )
}
export function DeveloperSetup({
    snapshot,
    run,
    initialTarget = 'Terminal'
}: {
    snapshot: Snapshot
    run: Run
    initialTarget?: string
}) {
    const [target, setTarget] = useState(initialTarget)
    const proxy = `http://127.0.0.1:${snapshot.settings.port}`
    const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
    const snippets: Record<string, string> = {
        ...setupInstructions(snapshot.settings.port, snapshot.certificatePath),
        Terminal: `export HTTP_PROXY=${q(proxy)}\nexport HTTPS_PROXY=${q(proxy)}\nexport NODE_EXTRA_CA_CERTS=${q(snapshot.certificatePath)}\ncurl --proxy ${q(proxy)} --cacert ${q(snapshot.certificatePath)} https://example.com`,
        'Node.js': `// Start Node with NODE_EXTRA_CA_CERTS pointing to the exported certificate.\n// Node 24+: enable environment proxy support.\n// HTTP_PROXY=${proxy} HTTPS_PROXY=${proxy} NODE_USE_ENV_PROXY=1 node app.js\nconst response = await fetch('https://example.com');\nconsole.log(await response.text());`,
        Python: `import requests\nresponse = requests.get(\n    'https://example.com',\n    proxies={'http': '${proxy}', 'https': '${proxy}'},\n    verify=${JSON.stringify(snapshot.certificatePath)}\n)\nprint(response.text)`,
        Browser: `1. Start Fluxy capture.\n2. Install & Trust the Fluxy Electron Root CA.\n3. Enable System Proxy in Fluxy, or configure your browser:\n   HTTP proxy: 127.0.0.1, port ${snapshot.settings.port}\n   HTTPS proxy: 127.0.0.1, port ${snapshot.settings.port}\n4. Restart the browser and open your test URL.`,
        'iOS / Android': `1. Disable “Listen on localhost only” in Settings.\n2. Connect your device and Mac to the same Wi-Fi.\n3. Set the device Wi-Fi proxy to your Mac's LAN IP, port ${snapshot.settings.port}.\n4. Export and install the Fluxy Electron Root CA on the device.\n5. On iOS, enable full certificate trust.\n6. Open an HTTPS URL. Apps with certificate pinning require a debug build.`
    }
    return (
        <div className="setup-layout">
            <aside>
                {Object.keys(snippets).map((name) => (
                    <Button
                        className={target === name ? 'selected' : ''}
                        key={name}
                        onClick={() => setTarget(name)}
                    >
                        {name}
                    </Button>
                ))}
            </aside>
            <main>
                <h2>{target}</h2>
                <p className="muted">Connect your development client to Fluxy.</p>
                <pre>{snippets[target]}</pre>
                <Button
                    onClick={() =>
                        void run(() => window.fluxy.copy(snippets[target]), 'Setup copied')
                    }
                >
                    <Copy size={14} />
                    Copy Instructions
                </Button>
            </main>
        </div>
    )
}
export function MCPSettings({ snapshot, run }: { snapshot: Snapshot; run: Run }) {
    const [enabled, setEnabled] = useState(snapshot.settings.mcpEnabled)
    const [port, setPort] = useState(snapshot.settings.mcpPort)
    const [redact, setRedact] = useState(snapshot.settings.mcpRedact)
    return (
        <div className="settings-form">
            <h3>Local MCP Server</h3>
            <p>
                Connect AI clients to ten read-only tools for captured traffic, proxy status,
                certificates, and rules.
            </p>
            <label className="check">
                <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                />
                Enable MCP Server
            </label>
            <label>
                Port
                <Input
                    type="number"
                    min="1024"
                    max="65535"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                />
            </label>
            <label className="check">
                <input
                    type="checkbox"
                    checked={redact}
                    onChange={(e) => setRedact(e.target.checked)}
                />
                Redact sensitive data before sending to AI
            </label>
            <Button
                className="primary"
                onClick={() =>
                    void run(
                        () =>
                            window.fluxy.settings({
                                ...snapshot.settings,
                                mcpEnabled: enabled,
                                mcpPort: port,
                                mcpRedact: redact
                            }),
                        'MCP settings saved'
                    )
                }
            >
                Save MCP Settings
            </Button>
            <h4>Client configuration</h4>
            <p className="muted">
                The stdio bridge reads the local authentication token from a private handshake file.
                Paste this configuration into your MCP client.
            </p>
            <pre className="config-code">{snapshot.mcpConfig}</pre>
            <Button
                onClick={() =>
                    void run(
                        () => window.fluxy.copy(snapshot.mcpConfig),
                        'MCP configuration copied'
                    )
                }
            >
                <Copy size={14} />
                Copy Configuration
            </Button>
        </div>
    )
}
export function ScriptingEditor({ snapshot, run }: { snapshot: Snapshot; run: Run }) {
    const [scripts, setScripts] = useState(snapshot.scripts)
    const [selected, setSelected] = useState<string>()
    const current = scripts.find((s) => s.id === selected)
    const update = (patch: Partial<import('@shared/contracts/model').Script>) =>
        setScripts((old) => old.map((s) => (s.id === selected ? { ...s, ...patch } : s)))
    const add = () => {
        const id = crypto.randomUUID()
        setScripts([
            ...scripts,
            {
                id,
                name: 'New Script',
                enabled: false,
                pattern: 'https://example.com/*',
                phase: 'request',
                code: "// Mutate request headers or body, then return the request.\nrequest.headers['x-fluxy'] = 'hello';\nreturn request;"
            }
        ])
        setSelected(id)
    }
    return (
        <>
            <div className="rule-layout">
                <aside className="rule-list">
                    <div className="section-label">{scripts.length} SCRIPTS</div>
                    {scripts.map((s) => (
                        <Button
                            className={s.id === selected ? 'selected' : ''}
                            key={s.id}
                            onClick={() => setSelected(s.id)}
                        >
                            <span className={s.enabled ? 'green' : 'muted'}>●</span>
                            <span>
                                {s.name}
                                <small>
                                    {s.phase} · {s.pattern}
                                </small>
                            </span>
                        </Button>
                    ))}
                    <Button onClick={add}>
                        <Plus size={14} />
                        Add Script
                    </Button>
                </aside>
                <div className="rule-form">
                    {current ? (
                        <>
                            <label className="check">
                                <input
                                    type="checkbox"
                                    checked={current.enabled}
                                    onChange={(e) => update({ enabled: e.target.checked })}
                                />
                                Enable script
                            </label>
                            <label>
                                Name
                                <Input
                                    value={current.name}
                                    onChange={(e) => update({ name: e.target.value })}
                                />
                            </label>
                            <label>
                                URL pattern
                                <Input
                                    value={current.pattern}
                                    onChange={(e) => update({ pattern: e.target.value })}
                                />
                            </label>
                            <label>
                                Phase
                                <select
                                    value={current.phase}
                                    onChange={(e) =>
                                        update({ phase: e.target.value as 'request' | 'response' })
                                    }
                                >
                                    <option value="request">Request</option>
                                    <option value="response">Response</option>
                                </select>
                            </label>
                            <label>
                                JavaScript
                                <Textarea
                                    className="script-editor"
                                    aria-label="Script code"
                                    spellCheck={false}
                                    value={current.code}
                                    onChange={(e) => update({ code: e.target.value })}
                                />
                            </label>
                            <p className="muted">
                                Return {current.phase} with modified headers, body
                                {current.phase === 'response' ? ', or status' : ', method, or URL'}.
                                Scripts have no filesystem, Node.js, or network access. Maximum
                                body: 2 MB; timeout: 5 seconds.
                            </p>
                            <Button
                                className="danger"
                                onClick={() => {
                                    setScripts(scripts.filter((s) => s.id !== current.id))
                                    setSelected(undefined)
                                }}
                            >
                                <Trash2 size={14} />
                                Delete Script
                            </Button>
                        </>
                    ) : (
                        <div className="subtle-empty">
                            <Code2 size={32} />
                            <h3>Scripting</h3>
                            <p>Transform requests and responses with JavaScript.</p>
                            <Button className="primary" onClick={add}>
                                Add Script
                            </Button>
                        </div>
                    )}
                </div>
            </div>
            <footer className="modal-footer">
                <span className="muted">
                    On failure, original traffic is preserved and the error appears in Logs.
                </span>
                <Button
                    className="primary"
                    onClick={() => void run(() => window.fluxy.scripts(scripts), 'Scripts saved')}
                >
                    Save Scripts
                </Button>
            </footer>
        </>
    )
}
export function UpstreamSettings({ snapshot, run }: { snapshot: Snapshot; run: Run }) {
    const [config, setConfig] = useState(snapshot.settings.upstream)
    return (
        <div className="settings-form">
            <h3>Upstream Proxy</h3>
            <p>Route outbound HTTP and decrypted HTTPS traffic through another proxy.</p>
            <label className="check">
                <input
                    type="checkbox"
                    checked={config.enabled}
                    onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
                />
                Enable upstream proxy
            </label>
            <label>
                Proxy or PAC URL
                <Input
                    value={config.url}
                    onChange={(e) => setConfig({ ...config, url: e.target.value })}
                />
                <small>
                    http://host:port · https://host:port · socks5://host:port ·
                    pac+https://host/proxy.pac
                </small>
            </label>
            <label>
                Bypass hosts
                <Textarea
                    value={config.bypass.join('\n')}
                    onChange={(e) =>
                        setConfig({ ...config, bypass: e.target.value.split('\n').filter(Boolean) })
                    }
                />
                <small>One wildcard pattern per line. These hosts connect directly.</small>
            </label>
            <p className="muted">
                Encrypted CONNECT tunnels outside SSL inspection are blocked while upstream routing
                is enabled, unless their host is in the bypass list.
            </p>
            <Button
                className="primary"
                onClick={() =>
                    void run(
                        () => window.fluxy.settings({ ...snapshot.settings, upstream: config }),
                        'Upstream settings saved'
                    )
                }
            >
                Save Upstream Settings
            </Button>
        </div>
    )
}
