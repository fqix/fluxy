import { useState, useEffect } from 'react'
import { breakpointTemplateSchema, type Snapshot, type Transaction } from '../../shared/model'
import { breakpointMessage, parseBreakpointMessage } from '../../shared/breakpoints'
import type { Run } from './Inspector'

const savedDrafts = new Map<string, string>()
export function pruneBreakpointDrafts(transactions: Transaction[]) {
    const keys = new Set(
        transactions.filter((t) => t.state === 'paused').map((t) => `${t.id}:${t.breakpointPhase}`)
    )
    for (const key of savedDrafts.keys()) if (!keys.has(key)) savedDrafts.delete(key)
}
function PauseEditor({
    t,
    snapshot,
    run,
    raw,
    setRaw
}: {
    t: Transaction
    snapshot: Snapshot
    run: Run
    raw: string
    setRaw: (value: string) => void
}) {
    const phase = t.breakpointPhase ?? 'request'
    const [name, setName] = useState('')
    return (
        <div className="settings-form">
            <h3>{phase === 'request' ? 'Request' : 'Response'} breakpoint</h3>
            <code>{t.url}</code>
            <p>
                {t.breakpointRuleName} · {t.client} · {new Date(t.timestamp).toLocaleTimeString()}
            </p>
            {t.breakpointBodyEditable === false && (
                <p role="status">
                    Binary, compressed or oversized body: original bytes are preserved; edit headers
                    and request/status line only.
                </p>
            )}
            {phase === 'request' && t.ssl && (
                <p className="muted">
                    HTTPS authority is fixed. The path and query remain editable.
                </p>
            )}
            <label>
                Apply template
                <select
                    aria-label="Apply breakpoint template"
                    defaultValue=""
                    onChange={(e) => {
                        const template = snapshot.templates.find((t) => t.id === e.target.value)
                        if (template) {
                            // A request template contributes method, path, headers and body, retaining this connection's authority.
                            let message = template.message
                            if (phase === 'request')
                                message = message.replace(
                                    /^(\S+)\s+(https?:\/\/\S+)/,
                                    (_, method, value) =>
                                        `${method} ${new URL(value).pathname}${new URL(value).search}`
                                )
                            message = message.replace(
                                /^host:.*$/gim,
                                `Host: ${new URL(t.url).host}`
                            )
                            setRaw(message)
                        }
                    }}
                >
                    <option value="">Choose template</option>
                    {snapshot.templates
                        .filter((t) => t.phase === phase)
                        .map((t) => (
                            <option key={t.id} value={t.id}>
                                {t.name}
                            </option>
                        ))}
                </select>
            </label>
            <label>
                HTTP message
                <textarea
                    aria-label="Breakpoint HTTP message"
                    rows={15}
                    value={raw}
                    onChange={(e) => setRaw(e.target.value)}
                />
            </label>
            <div className="button-row">
                <button
                    className="primary"
                    onClick={() =>
                        void run(() =>
                            window.fluxy.breakpoint(
                                t.id,
                                'continue',
                                parseBreakpointMessage(
                                    raw,
                                    phase,
                                    t.url,
                                    t.breakpointBodyEditable === false
                                )
                            )
                        )
                    }
                >
                    Apply and Continue
                </button>
                <button onClick={() => void run(() => window.fluxy.breakpoint(t.id, 'continue'))}>
                    Continue Unchanged
                </button>
                <button onClick={() => void run(() => window.fluxy.breakpoint(t.id, 'abort'))}>
                    Abort
                </button>
            </div>
            <label>
                Template name
                <input
                    aria-label="Breakpoint template name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
            </label>
            <button
                disabled={!name.trim()}
                onClick={() =>
                    void run(async () => {
                        parseBreakpointMessage(
                            raw,
                            phase,
                            t.url,
                            t.breakpointBodyEditable === false
                        )
                        await window.fluxy.templates([
                            ...snapshot.templates,
                            breakpointTemplateSchema.parse({
                                id: crypto.randomUUID(),
                                name,
                                phase,
                                message: raw
                            })
                        ])
                        setName('')
                    }, 'Template saved')
                }
            >
                Save as Template
            </button>
            <p className="muted">
                Paused messages wait until you continue, abort, stop capture, or the client
                disconnects. Binary, compressed and bodies over 2 MB remain byte-for-byte unchanged.
            </p>
        </div>
    )
}
export function BreakpointQueue({ snapshot, run }: { snapshot: Snapshot; run: Run }) {
    const [selected, setSelected] = useState('')
    const [drafts, setDrafts] = useState<Record<string, string>>(() =>
        Object.fromEntries(savedDrafts)
    )
    const paused = snapshot.transactions.filter((t) => t.state === 'paused')
    useEffect(() => {
        pruneBreakpointDrafts(snapshot.transactions)
        setDrafts(Object.fromEntries(savedDrafts))
    }, [snapshot.transactions])
    const current = paused.find((t) => t.id === selected) ?? paused[0]
    const currentKey = current ? `${current.id}:${current.breakpointPhase}` : ''
    return (
        <div className="rule-layout">
            <aside className="rule-list">
                <strong>{paused.length} paused</strong>
                <button
                    disabled={!paused.length}
                    onClick={() =>
                        void run(() =>
                            window.fluxy.applyBreakpoints(
                                paused.map((t) => ({
                                    id: t.id,
                                    edit: parseBreakpointMessage(
                                        savedDrafts.get(`${t.id}:${t.breakpointPhase}`) ??
                                            breakpointMessage(t, t.breakpointPhase!),
                                        t.breakpointPhase!,
                                        t.url,
                                        t.breakpointBodyEditable === false
                                    )
                                }))
                            )
                        )
                    }
                >
                    Apply All and Continue
                </button>
                <button
                    disabled={!paused.length}
                    onClick={() => void run(() => window.fluxy.breakpoints('continue'))}
                >
                    Continue All Unchanged
                </button>
                <button
                    disabled={!paused.length}
                    onClick={() => void run(() => window.fluxy.breakpoints('abort'))}
                >
                    Abort All
                </button>
                <div className="button-row">
                    <button
                        disabled={!current || paused.indexOf(current) === 0}
                        onClick={() => setSelected(paused[paused.indexOf(current) - 1].id)}
                    >
                        Previous
                    </button>
                    <button
                        disabled={!current || paused.indexOf(current) === paused.length - 1}
                        onClick={() => setSelected(paused[paused.indexOf(current) + 1].id)}
                    >
                        Next
                    </button>
                </div>
                {paused.map((t) => (
                    <button
                        key={t.id}
                        onClick={() => setSelected(t.id)}
                        className={current?.id === t.id ? 'selected' : ''}
                    >
                        {t.method} {t.path}
                        <small>
                            {t.breakpointPhase} · {t.host} · {t.client} · {t.breakpointRuleName}
                        </small>
                    </button>
                ))}
            </aside>
            {current ? (
                <PauseEditor
                    key={`${current.id}:${current.breakpointPhase}`}
                    t={current}
                    raw={
                        drafts[currentKey] ??
                        breakpointMessage(current, current.breakpointPhase ?? 'request')
                    }
                    setRaw={(value) => {
                        savedDrafts.set(currentKey, value)
                        setDrafts((previous) => ({ ...previous, [currentKey]: value }))
                    }}
                    snapshot={snapshot}
                    run={run}
                />
            ) : (
                <p className="subtle-empty">
                    No paused requests. Add a breakpoint rule to pause matching traffic.
                </p>
            )}
        </div>
    )
}
export function BreakpointTemplates({ snapshot, run }: { snapshot: Snapshot; run: Run }) {
    const [id, setID] = useState('')
    const [name, setName] = useState('')
    const [phase, setPhase] = useState<'request' | 'response'>('request')
    const [message, setMessage] = useState(
        'GET https://example.com/ HTTP/1.1\nAccept: application/json\n\n'
    )
    return (
        <div className="rule-layout">
            <aside className="rule-list">
                {snapshot.templates.map((t) => (
                    <button
                        key={t.id}
                        onClick={() => {
                            setID(t.id)
                            setName(t.name)
                            setPhase(t.phase)
                            setMessage(t.message)
                        }}
                    >
                        {t.name}
                        <small>{t.phase}</small>
                    </button>
                ))}
                <button
                    onClick={() => {
                        setID('')
                        setName('')
                        setMessage('GET https://example.com/ HTTP/1.1\n\n')
                        setPhase('request')
                    }}
                >
                    New Template
                </button>
            </aside>
            <div className="settings-form">
                <label>
                    Name
                    <input
                        aria-label="Template name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                    />
                </label>
                <label>
                    Phase
                    <select
                        aria-label="Template phase"
                        value={phase}
                        onChange={(e) => setPhase(e.target.value as 'request' | 'response')}
                    >
                        <option value="request">Request</option>
                        <option value="response">Response</option>
                    </select>
                </label>
                <label>
                    HTTP message
                    <textarea
                        aria-label="Template HTTP message"
                        rows={15}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                    />
                </label>
                <div className="button-row">
                    <button
                        disabled={!name.trim()}
                        onClick={() =>
                            void run(async () => {
                                parseBreakpointMessage(message, phase)
                                const value = breakpointTemplateSchema.parse({
                                    id: id || crypto.randomUUID(),
                                    name,
                                    phase,
                                    message
                                })
                                await window.fluxy.templates([
                                    ...snapshot.templates.filter((t) => t.id !== value.id),
                                    value
                                ])
                                setID(value.id)
                            }, 'Template saved')
                        }
                    >
                        Save Template
                    </button>
                    <button
                        disabled={!id}
                        onClick={() =>
                            void run(async () => {
                                await window.fluxy.templates(
                                    snapshot.templates.filter((t) => t.id !== id)
                                )
                                setID('')
                                setName('')
                            })
                        }
                    >
                        Delete Template
                    </button>
                </div>
            </div>
        </div>
    )
}
export function KeyboardShortcuts({ run }: { run: Run }) {
    const [shortcuts, setShortcuts] = useState<{ label: string; accelerator: string }[]>([])
    useEffect(() => {
        void run(async () => setShortcuts(await window.fluxy.shortcuts()))
    }, [run])
    return (
        <table className="kv">
            <thead>
                <tr>
                    <th>Action</th>
                    <th>Shortcut</th>
                </tr>
            </thead>
            <tbody>
                {shortcuts.map((s, i) => (
                    <tr key={i}>
                        <td>{s.label}</td>
                        <td>
                            <kbd>{s.accelerator}</kbd>
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    )
}
