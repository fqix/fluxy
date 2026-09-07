import { HeaderTable } from '@/components/data/HeaderTable'
import type { Run } from '@/types/actions'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { timingLabels } from '@shared/traffic/timing'
import { useState, useEffect } from 'react'
import { protocolPanels } from '@shared/traffic/protocols'
import { Copy, LockKeyhole, Pin, Send, Bookmark, X, ArrowDown, ArrowUp } from 'lucide-react'
import { bytes, pretty, toCurl, type Transaction } from '@shared/contracts/model'

function Body({
    text,
    tab,
    base64,
    contentType
}: {
    text: string
    tab: string
    base64?: string
    contentType?: string
}) {
    const [search, setSearch] = useState('')
    if (
        tab === 'Preview' &&
        base64 &&
        /^image\/(png|jpeg|gif|webp|avif|bmp)/.test(contentType ?? '')
    )
        return (
            <div className="image-preview">
                <img src={`data:${contentType};base64,${base64}`} />
            </div>
        )
    let value = tab === 'JSON' || tab === 'Body' || tab === 'Preview' ? pretty(text) : text
    if (tab === 'Hex') {
        const data = new TextEncoder().encode(text)
        value = Array.from(
            { length: Math.ceil(Math.min(data.length, 65536) / 16) },
            (_, i) =>
                `${(i * 16).toString(16).padStart(8, '0')}  ${[...data.slice(i * 16, i * 16 + 16)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`
        ).join('\n')
    }
    const lines = value.split('\n')
    return (
        <>
            <div className="body-tools">
                <span>{bytes(new TextEncoder().encode(text).length)} · UTF-8</span>
                <Input
                    aria-label="Find in payload"
                    placeholder="Find in payload…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
            </div>
            <div className="code-view">
                {value ? (
                    lines.map((line, i) =>
                        !search || line.toLowerCase().includes(search.toLowerCase()) ? (
                            <div className="code-line" key={i}>
                                <span className="line-number">{i + 1}</span>
                                <code>{line || ' '}</code>
                            </div>
                        ) : null
                    )
                ) : (
                    <div className="subtle-empty">No body</div>
                )}
            </div>
        </>
    )
}
function Pane({
    t,
    side,
    previewTabs,
    protobufType
}: {
    t: Transaction
    side: 'Request' | 'Response'
    previewTabs: string[]
    protobufType: string
}) {
    const [tab, setTab] = useState('Headers')
    const request = side === 'Request'
    const protocols = protocolPanels(t)
    const tabs = (
        request
            ? ['Headers', 'Query', 'Body', 'Cookies', 'Raw', 'JSON', 'Hex']
            : [
                  'Headers',
                  'Body',
                  'Set-Cookie',
                  'Timeline',
                  'JSON',
                  'Preview',
                  'Raw',
                  'Hex',
                  ...(t.protocol === 'WebSocket' ? ['Frames'] : []),
                  ...protocols.map((p) => p.title)
              ]
    ).filter((tab) => !['JSON', 'Preview', 'Raw', 'Hex'].includes(tab) || previewTabs.includes(tab))
    if (protobufType) tabs.push('Protobuf')
    useEffect(() => {
        if (!tabs.includes(tab)) setTab('Headers')
    }, [previewTabs, t.protocol, protobufType])
    const h = request ? t.requestHeaders : t.responseHeaders
    const body = request ? t.requestBody : t.responseBody
    return (
        <section className="inspector-pane">
            <div className="pane-title">{side}</div>
            <div className="inspector-tabs">
                {tabs.map((item) => (
                    <Button
                        key={item}
                        className={tab === item ? 'active' : ''}
                        onClick={() => setTab(item)}
                    >
                        {item}
                    </Button>
                ))}
            </div>
            <div className="pane-body">
                {tab === 'Protobuf' ? (
                    <ProtobufBody
                        key={`${t.id}:${t.state}:${t.requestBytes}:${t.responseBytes}`}
                        id={t.id}
                        side={request ? 'request' : 'response'}
                        type={protobufType}
                    />
                ) : tab === 'Headers' ? (
                    <HeaderTable values={h} />
                ) : tab === 'Query' ? (
                    <HeaderTable values={[...new URL(t.url).searchParams]} />
                ) : tab === 'Cookies' || tab === 'Set-Cookie' ? (
                    <HeaderTable
                        values={(h[request ? 'cookie' : 'set-cookie'] ?? '')
                            .split(request ? ';' : '\n')
                            .filter(Boolean)
                            .map((c): [string, string] => {
                                const i = c.indexOf('=')
                                return [
                                    i >= 0 ? c.slice(0, i).trim() : c,
                                    i >= 0 ? c.slice(i + 1) : ''
                                ]
                            })}
                    />
                ) : tab === 'Timeline' ? (
                    <div className="timing">
                        <h4>Request timeline</h4>
                        <HeaderTable
                            values={{
                                Started: new Date(t.timestamp).toLocaleString(),
                                Duration: `${t.duration} ms`,
                                Request: bytes(t.requestBytes),
                                Response: bytes(t.responseBytes)
                            }}
                        />
                        <div className="timing-bar" />
                        <p className="muted">Total elapsed time, including upstream transfer.</p>
                    </div>
                ) : tab === 'Frames' ? (
                    <div className="frames">
                        {t.frames.map((f) => (
                            <div key={f.id}>
                                <span className={f.direction === 'send' ? 'green' : 'blue'}>
                                    {f.direction === 'send' ? (
                                        <ArrowUp size={12} />
                                    ) : (
                                        <ArrowDown size={12} />
                                    )}
                                    {new Date(f.time).toLocaleTimeString()}
                                </span>
                                <pre>{f.body}</pre>
                            </div>
                        ))}
                    </div>
                ) : protocols.some((p) => p.title === tab) ? (
                    <>
                        <HeaderTable values={protocols.find((p) => p.title === tab)!.fields} />
                        <pre className="protocol-body">
                            {protocols.find((p) => p.title === tab)!.body}
                        </pre>
                    </>
                ) : (
                    <Body
                        key={`${side}-${t.id}-${tab}`}
                        tab={tab}
                        text={
                            tab === 'Raw'
                                ? `${request ? `${t.method} ${t.path} HTTP/1.1` : `HTTP/1.1 ${t.status ?? ''} ${t.statusMessage ?? ''}`}\n${Object.entries(
                                      h
                                  )
                                      .map(([k, v]) => `${k}: ${v}`)
                                      .join('\n')}\n\n${body}`
                                : body
                        }
                        base64={request ? undefined : t.responseBase64}
                        contentType={h['content-type']}
                    />
                )}
            </div>
        </section>
    )
}
export function Inspector({
    protobufType = '',
    previewTabs = ['JSON', 'Preview', 'Raw', 'Hex'],
    t,
    run,
    close,
    compose
}: {
    protobufType?: string
    previewTabs?: string[]
    t: Transaction
    run: Run
    close: () => void
    compose: () => void
}) {
    return (
        <div className="inspector">
            <header className="inspector-title">
                <span className={`method ${t.method.toLowerCase()}`}>{t.method}</span>
                <span className={`status ${Number(t.status) >= 400 ? 'orange' : 'green'}`}>
                    {t.status ?? '—'}
                </span>
                {t.ssl && <LockKeyhole size={12} className="green" />}
                <span className="request-url">{t.url}</span>
                <Button
                    title="Copy as cURL"
                    onClick={() => void run(() => window.fluxy.copy(toCurl(t)), 'Copied as cURL')}
                >
                    <Copy size={13} />
                </Button>
                <Button
                    title="Pin request"
                    className={t.pinned ? 'blue' : ''}
                    onClick={() =>
                        void run(() => window.fluxy.updateTransaction(t.id, { pinned: !t.pinned }))
                    }
                >
                    <Pin size={13} />
                </Button>
                <Button
                    title="Save request"
                    className={t.saved ? 'blue' : ''}
                    onClick={() =>
                        void run(() => window.fluxy.updateTransaction(t.id, { saved: !t.saved }))
                    }
                >
                    <Bookmark size={13} />
                </Button>
                <Button title="Edit and resend" onClick={compose}>
                    <Send size={13} />
                </Button>
                <Button title="Close inspector" onClick={close}>
                    <X size={13} />
                </Button>
            </header>
            {t.error && <div className="error-banner">{t.error}</div>}
            {t.truncated && (
                <div className="warning-banner">
                    Capture limit reached. The inspector contains a bounded preview; forwarding
                    continues.
                </div>
            )}
            {t.state === 'paused' && (
                <div className="breakpoint-banner">
                    <strong>Paused at breakpoint</strong>
                    <span>{t.rule} · automatically aborted after 2 minutes</span>
                    <Button onClick={() => void run(() => window.fluxy.breakpoint(t.id, 'abort'))}>
                        Abort
                    </Button>
                    <Button
                        className="primary"
                        onClick={() => void run(() => window.fluxy.breakpoint(t.id, 'continue'))}
                    >
                        Continue
                    </Button>
                </div>
            )}
            <div className="inspector-columns">
                <Pane t={t} side="Request" previewTabs={previewTabs} protobufType={protobufType} />
                <Pane t={t} side="Response" previewTabs={previewTabs} protobufType={protobufType} />
            </div>
        </div>
    )
}
export function Details({ t, run }: { t?: Transaction; run: Run }) {
    if (!t) return <div className="subtle-empty">Select a request to view details.</div>
    return (
        <div className="details-content">
            <h4>Overview</h4>
            <HeaderTable
                values={{
                    URL: t.url,
                    Method: t.method,
                    Status: `${t.status ?? '—'} ${t.statusMessage ?? ''}`,
                    Protocol: t.protocol,
                    Client: t.client,
                    'Client source': t.clientSource ?? 'unknown',
                    'Client PID': t.clientPID?.toString() ?? '—',
                    'Client identity': t.clientIdentity ?? '—',
                    Started: new Date(t.timestamp).toLocaleString(),
                    Duration: `${t.duration} ms`,
                    Request: bytes(t.requestBytes),
                    Response: bytes(t.responseBytes),
                    ...(t.rule ? { Rule: t.rule } : {})
                }}
            />
            {t.timings && (
                <>
                    <h4>Timing</h4>
                    <HeaderTable
                        values={Object.fromEntries(
                            Object.entries(timingLabels).map(([key, label]) => [
                                label,
                                t.timings![key as keyof typeof timingLabels] === undefined
                                    ? 'Unavailable'
                                    : t.timings![key as keyof typeof timingLabels]!.toFixed(1) +
                                      ' ms'
                            ])
                        )}
                    />
                </>
            )}
            <h4>Notes</h4>
            <Textarea
                aria-label="Request notes"
                key={t.id}
                defaultValue={t.note}
                placeholder="Add a note to this request…"
                onBlur={(e) =>
                    void run(() => window.fluxy.updateTransaction(t.id, { note: e.target.value }))
                }
            />
            <h4>TLS</h4>
            <p className="muted">
                {t.ssl
                    ? 'HTTPS intercepted using the local Fluxy root certificate.'
                    : t.method === 'CONNECT'
                      ? 'Encrypted tunnel. Payload was not decrypted.'
                      : 'This request does not use TLS.'}
            </p>
        </div>
    )
}

function ProtobufBody({
    id,
    side,
    type
}: {
    id: string
    side: 'request' | 'response'
    type: string
}) {
    const [text, setText] = useState('Decoding…')
    useEffect(() => {
        let active = true
        void window.fluxy
            .decodeProtobuf(id, side, type)
            .then((value) => {
                if (active) setText(JSON.stringify(value, null, 2))
            })
            .catch((error) => {
                if (active) setText(String(error))
            })
        return () => {
            active = false
        }
    }, [id, side, type])
    return <pre>{text}</pre>
}
