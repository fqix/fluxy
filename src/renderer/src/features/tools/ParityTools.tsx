import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { Run } from '@/types/actions'
import { terminalEnvironment } from '@shared/setup'
import { useState } from 'react'
import type { Snapshot, Transaction } from '@shared/model'
import type { ProjectAction } from '@shared/projects'

export function ProjectManager({
    snapshot,
    change,
    run,
    exportProject,
    importProject
}: {
    snapshot: Snapshot
    change: (action: ProjectAction) => Promise<unknown>
    run: Run
    exportProject: () => Promise<unknown>
    importProject: () => Promise<unknown>
}) {
    const [name, setName] = useState('')
    const active = snapshot.projects.projects.find((p) => p.id === snapshot.projects.activeID)!
    return (
        <div className="settings-form">
            {snapshot.projectError ? (
                <p role="alert">{snapshot.projectError}</p>
            ) : (
                <>
                    <h3>Projects</h3>
                    <p>
                        Each project keeps its own tabs and filters. Captured traffic and proxy
                        rules are shared.
                    </p>
                    {snapshot.projects.projects.map((p) => (
                        <div className="button-row" key={p.id}>
                            <Button
                                disabled={p.id === active.id}
                                onClick={() => void run(() => change({ kind: 'switch', id: p.id }))}
                            >
                                {p.id === active.id ? '✓ ' : ''}
                                {p.name} · {p.tabs.length} tabs
                            </Button>
                            <Button
                                disabled={snapshot.projects.projects.length <= 1}
                                onClick={() => void run(() => change({ kind: 'delete', id: p.id }))}
                            >
                                Delete {p.name}
                            </Button>
                        </div>
                    ))}
                    <label>
                        Project name
                        <Input
                            aria-label="Project name"
                            value={name}
                            maxLength={100}
                            onChange={(e) => setName(e.target.value)}
                        />
                    </label>
                    <div className="button-row">
                        <Button
                            disabled={!name.trim()}
                            onClick={() => void run(() => change({ kind: 'create', name }))}
                        >
                            New Project
                        </Button>
                        <Button
                            disabled={!name.trim()}
                            onClick={() =>
                                void run(() => change({ kind: 'rename', id: active.id, name }))
                            }
                        >
                            Rename Active Project
                        </Button>
                        <Button onClick={() => void run(exportProject)}>
                            Export Configuration
                        </Button>
                        <Button onClick={() => void run(importProject)}>
                            Import Configuration
                        </Button>
                    </div>
                </>
            )}
            {snapshot.projectError && (
                <Button onClick={() => void run(() => change({ kind: 'repair' }))}>
                    Repair Projects
                </Button>
            )}
        </div>
    )
}
export function RequestNote({
    transaction,
    run,
    close
}: {
    transaction: Transaction
    run: Run
    close: () => void
}) {
    const [note, setNote] = useState(transaction.note)
    return (
        <form
            className="settings-form"
            onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                    await window.fluxy.updateTransaction(transaction.id, { note })
                    close()
                })
            }}
        >
            <label>
                Request note
                <Textarea
                    autoFocus
                    aria-label="Request note"
                    maxLength={100000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                />
            </label>
            <Button className="primary">Save Note</Button>
        </form>
    )
}
export function InspectionSettings({
    title,
    snapshot,
    run
}: {
    title: string
    snapshot: Snapshot
    run: Run
}) {
    const [bypass, setBypass] = useState(snapshot.settings.fullBypassHosts.join('\n'))
    const [previews, setPreviews] = useState(snapshot.settings.previewTabs)
    const [columns, setColumns] = useState(snapshot.settings.headerColumns)
    return (
        <div className="settings-form">
            {title === 'Full Proxy Bypass' ? (
                <>
                    <p>
                        Matching hosts bypass capture, decryption and rules. Use * for wildcard
                        matching. TUN traffic retains its configured egress.
                    </p>
                    <label>
                        Hosts
                        <Textarea
                            aria-label="Bypass hosts"
                            rows={12}
                            value={bypass}
                            onChange={(e) => setBypass(e.target.value)}
                        />
                    </label>
                </>
            ) : title === 'Inspector Preview Tabs' ? (
                <>
                    <p>Choose the optional body preview tabs shown in the inspector.</p>
                    {(['JSON', 'Preview', 'Raw', 'Hex'] as const).map((tab) => (
                        <label className="check" key={tab}>
                            <input
                                type="checkbox"
                                checked={previews.includes(tab)}
                                onChange={(e) =>
                                    setPreviews(
                                        e.target.checked
                                            ? [...previews, tab]
                                            : previews.filter((t) => t !== tab)
                                    )
                                }
                            />
                            {tab}
                        </label>
                    ))}
                </>
            ) : (
                <>
                    <p>Add request or response headers as columns in the traffic table.</p>
                    {columns.map((column, i) => (
                        <div className="button-row" key={column.id}>
                            <Input
                                aria-label={`Column ${i + 1} name`}
                                placeholder="Column name"
                                value={column.name}
                                onChange={(e) =>
                                    setColumns(
                                        columns.map((c) =>
                                            c.id === column.id ? { ...c, name: e.target.value } : c
                                        )
                                    )
                                }
                            />
                            <Input
                                aria-label={`Column ${i + 1} header`}
                                placeholder="Header name"
                                value={column.header}
                                onChange={(e) =>
                                    setColumns(
                                        columns.map((c) =>
                                            c.id === column.id
                                                ? { ...c, header: e.target.value }
                                                : c
                                        )
                                    )
                                }
                            />
                            <select
                                aria-label={`Column ${i + 1} source`}
                                value={column.source}
                                onChange={(e) =>
                                    setColumns(
                                        columns.map((c) =>
                                            c.id === column.id
                                                ? {
                                                      ...c,
                                                      source: e.target.value as
                                                          'request' | 'response'
                                                  }
                                                : c
                                        )
                                    )
                                }
                            >
                                <option value="request">Request</option>
                                <option value="response">Response</option>
                            </select>
                            <Button
                                onClick={() =>
                                    setColumns(columns.filter((c) => c.id !== column.id))
                                }
                            >
                                Remove
                            </Button>
                        </div>
                    ))}
                    <Button
                        disabled={columns.length >= 20}
                        onClick={() =>
                            setColumns([
                                ...columns,
                                {
                                    id: crypto.randomUUID(),
                                    name: 'Header',
                                    header: 'content-type',
                                    source: 'response'
                                }
                            ])
                        }
                    >
                        Add Header Column
                    </Button>
                </>
            )}
            <Button
                className="primary"
                onClick={() =>
                    void run(
                        () =>
                            window.fluxy.settings({
                                ...snapshot.settings,
                                ...(title === 'Full Proxy Bypass'
                                    ? {
                                          fullBypassHosts: bypass
                                              .split('\n')
                                              .map((s) => s.trim())
                                              .filter(Boolean)
                                      }
                                    : title === 'Inspector Preview Tabs'
                                      ? { previewTabs: previews }
                                      : { headerColumns: columns })
                            }),
                        'Settings saved'
                    )
                }
            >
                Save Settings
            </Button>
        </div>
    )
}

export function PublishGist({ ids, run }: { ids: string[]; run: Run }) {
    const [review, setReview] = useState<{ id: string; content: string }>()
    const [token, setToken] = useState('')
    const [description, setDescription] = useState('Fluxy traffic capture')
    const [publicGist, setPublicGist] = useState(false)
    const [url, setURL] = useState('')
    return (
        <div className="settings-form">
            <p>
                Review the exact HAR before publishing to GitHub. Common credentials are redacted;
                inspect URLs and payloads for other private data. Secret gists can be read by anyone
                with their link.
            </p>
            <Button
                onClick={() => void run(async () => setReview(await window.fluxy.gistReview(ids)))}
            >
                Preview Selected Requests
            </Button>
            {review && (
                <>
                    <pre className="review-context">{review.content}</pre>
                    <label>
                        Description
                        <Input
                            value={description}
                            maxLength={500}
                            onChange={(e) => setDescription(e.target.value)}
                        />
                    </label>
                    <label>
                        GitHub token (Gists write permission)
                        <Input
                            aria-label="GitHub token"
                            type="password"
                            autoComplete="off"
                            value={token}
                            onChange={(e) => setToken(e.target.value)}
                        />
                    </label>
                    <label className="check">
                        <input
                            type="checkbox"
                            checked={publicGist}
                            onChange={(e) => setPublicGist(e.target.checked)}
                        />
                        Public gist
                    </label>
                    <Button
                        className="primary"
                        disabled={!token.trim()}
                        onClick={() =>
                            void run(async () => {
                                const id = review.id
                                setReview(undefined)
                                try {
                                    setURL(
                                        await window.fluxy.gistPublish({
                                            reviewID: id,
                                            token,
                                            description,
                                            public: publicGist
                                        })
                                    )
                                } finally {
                                    setToken('')
                                }
                            })
                        }
                    >
                        Publish Reviewed HAR to GitHub
                    </Button>
                </>
            )}
            {url && (
                <>
                    <p role="status">Published: {url}</p>
                    <Button onClick={() => void run(() => window.fluxy.copy(url), 'Link copied')}>
                        Copy Gist Link
                    </Button>
                </>
            )}
        </div>
    )
}

export function ProtobufSettings({ snapshot, run }: { snapshot: Snapshot; run: Run }) {
    const [source, setSource] = useState(
        'syntax = "proto3";\nmessage Example { string message = 1; }'
    )
    const [name, setName] = useState('schema.proto')
    const [types, setTypes] = useState<string[]>([])
    return (
        <div className="settings-form">
            <p>
                Add the .proto definitions and their imported definitions. Select a message type,
                then use the Protobuf inspector tab to decode captured bytes.
            </p>
            {snapshot.settings.protobufSchemas.map((s) => (
                <div className="button-row" key={s.id}>
                    <span>{s.name}</span>
                    <Button
                        onClick={() =>
                            void run(() =>
                                window.fluxy.settings({
                                    ...snapshot.settings,
                                    protobufType: '',
                                    protobufSchemas: snapshot.settings.protobufSchemas.filter(
                                        (v) => v.id !== s.id
                                    )
                                })
                            )
                        }
                    >
                        Remove
                    </Button>
                </div>
            ))}
            <label>
                Schema name
                <Input
                    aria-label="Schema name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
            </label>
            <label>
                Schema source
                <Textarea
                    aria-label="Protobuf schema"
                    rows={14}
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                />
            </label>
            <Button
                onClick={() =>
                    void run(async () => {
                        await window.fluxy.settings({
                            ...snapshot.settings,
                            protobufSchemas: [
                                ...snapshot.settings.protobufSchemas,
                                { id: crypto.randomUUID(), name, source }
                            ]
                        })
                        setTypes(await window.fluxy.protobufTypes())
                    }, 'Schema saved')
                }
            >
                Add Schema
            </Button>
            <Button
                onClick={() => void run(async () => setTypes(await window.fluxy.protobufTypes()))}
            >
                Load Message Types
            </Button>
            <label>
                Message type
                <select
                    aria-label="Protobuf message type"
                    value={snapshot.settings.protobufType}
                    onChange={(e) =>
                        void run(() =>
                            window.fluxy.settings({
                                ...snapshot.settings,
                                protobufType: e.target.value
                            })
                        )
                    }
                >
                    <option value="">Choose type</option>
                    {[...new Set([...types, snapshot.settings.protobufType])]
                        .filter(Boolean)
                        .map((t) => (
                            <option key={t}>{t}</option>
                        ))}
                </select>
            </label>
        </div>
    )
}

export function CustomCertificateSettings({ snapshot, run }: { snapshot: Snapshot; run: Run }) {
    const [name, setName] = useState('')
    const [kind, setKind] = useState<'root' | 'server' | 'client'>('server')
    const [host, setHost] = useState('')
    const [password, setPassword] = useState('')
    return (
        <div className="settings-form">
            {snapshot.customCertificateError && (
                <p role="alert">{snapshot.customCertificateError}</p>
            )}
            <p>
                Root identities sign intercepted host certificates; server identities replace the
                certificate for matching hosts; client identities authenticate upstream TLS
                connections. Stop capture before changing identities. An imported root must already
                be trusted by your test clients.
            </p>
            {snapshot.customCertificates.map((c) => (
                <div key={c.id}>
                    <strong>
                        {c.name} · {c.kind} · {c.host || 'All intercepted hosts'}
                    </strong>
                    <p>
                        {c.fingerprint}
                        <br />
                        Expires: {c.expires}
                    </p>
                    <Button
                        disabled={snapshot.running}
                        onClick={() => void run(() => window.fluxy.deleteCustomCertificate(c.id))}
                    >
                        Delete {c.name}
                    </Button>
                </div>
            ))}
            <label>
                Name
                <Input
                    aria-label="Certificate name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
            </label>
            <label>
                Use
                <select
                    aria-label="Certificate use"
                    value={kind}
                    onChange={(e) => setKind(e.target.value as typeof kind)}
                >
                    <option value="root">Root issuer</option>
                    <option value="server">Server identity</option>
                    <option value="client">Client identity</option>
                </select>
            </label>
            {kind !== 'root' && (
                <label>
                    Host pattern
                    <Input
                        aria-label="Certificate host"
                        value={host}
                        onChange={(e) => setHost(e.target.value)}
                        placeholder="*.example.com"
                    />
                </label>
            )}
            <label>
                Import password
                <Input
                    aria-label="Certificate password"
                    type="password"
                    autoComplete="off"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                />
            </label>
            <Button
                disabled={
                    snapshot.running || !name.trim() || Boolean(snapshot.customCertificateError)
                }
                onClick={() =>
                    void run(async () => {
                        try {
                            await window.fluxy.importCustomCertificate({
                                name,
                                kind,
                                host,
                                password
                            })
                        } finally {
                            setPassword('')
                        }
                    })
                }
            >
                Import Certificate and Key…
            </Button>
        </div>
    )
}

export function AutomaticSetup({ snapshot, run }: { snapshot: Snapshot; run: Run }) {
    return (
        <div className="settings-form">
            <p>
                Prepare a terminal session with the Fluxy proxy and CA environment. The action
                starts capture and generates a CA if needed. Configuration applies to this terminal
                and its child processes.
            </p>
            <pre>{terminalEnvironment(snapshot.settings.port, snapshot.certificatePath)}</pre>
            <p className="muted">
                curl and Python clients that honor these variables can use this session directly.
                Node.js clients also need a proxy-aware agent. Localhost is excluded by NO_PROXY;
                remove that value in the prepared terminal to capture local services.
            </p>
            <div className="button-row">
                <Button
                    onClick={() =>
                        void run(
                            async () =>
                                window.fluxy.copy(await window.fluxy.prepareTerminal('copy')),
                            'Prepared environment copied'
                        )
                    }
                >
                    Prepare and Copy Environment
                </Button>
                <Button
                    className="primary"
                    onClick={() =>
                        void run(
                            () => window.fluxy.prepareTerminal('open'),
                            'Prepared terminal opened'
                        )
                    }
                >
                    Open Prepared Terminal
                </Button>
            </div>
        </div>
    )
}
