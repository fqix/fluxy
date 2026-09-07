import { useEffect, useRef, useState } from 'react'
import type { Transaction } from '../../shared/model'
import type { DiffResult, DiffTarget, DiffPair } from '../../shared/diff'
export function DiffView({
    transactions,
    initialIDs = [],
    followUp
}: {
    transactions: Transaction[]
    initialIDs?: string[]
    followUp?: (action: string, t: Transaction) => void
}) {
    const [left, setLeft] = useState(initialIDs[0] ?? transactions[0]?.id ?? ''),
        [right, setRight] = useState(initialIDs[1] ?? transactions[1]?.id ?? '')
    const [target, setTarget] = useState<DiffTarget>('Response'),
        [mode, setMode] = useState('Side by Side'),
        [source, setSource] = useState(transactions.length ? 'Captured requests' : 'Text')
    const [textLeft, setTextLeft] = useState(''),
        [textRight, setTextRight] = useState(''),
        [query, setQuery] = useState('')
    const [pairs, setPairs] = useState<DiffPair[]>([]),
        [saved, setSaved] = useState<string>(),
        [changesOnly, setChangesOnly] = useState(false)
    const [result, setResult] = useState<DiffResult>(),
        [error, setError] = useState(''),
        [notice, setNotice] = useState('')
    const [actionSide, setActionSide] = useState('left')
    const viewer = useRef<HTMLDivElement>(null)
    const sections = useRef<(HTMLElement | null)[]>([]),
        [jump, setJump] = useState(-1)
    const candidates = [
        ...new Map(
            [...pairs.flatMap((p) => [p.left, p.right]), ...transactions].map((t) => [t.id, t])
        ).values()
    ]
    const activePair = pairs.find((p) => p.id === saved)
    const a = activePair?.left ?? candidates.find((t) => t.id === left),
        b = activePair?.right ?? candidates.find((t) => t.id === right)
    const run = async (action: () => Promise<unknown>) => {
        setError('')
        try {
            await action()
        } catch (e) {
            setError(String(e))
        }
    }
    useEffect(() => {
        void run(async () => setPairs(await window.fluxy.diffHistory()))
    }, [])
    useEffect(() => {
        let active = true
        setError('')
        setResult(undefined)
        const timer = setTimeout(
            () => {
                const request =
                    source === 'Text'
                        ? window.fluxy.diffText(textLeft, textRight)
                        : saved
                          ? window.fluxy.diffSaved(saved, target)
                          : a && b
                            ? window.fluxy.diff(a.id, b.id, target)
                            : undefined
                void request
                    ?.then((r) => {
                        if (active) setResult(r)
                    })
                    .catch((e) => {
                        if (active) setError(String(e))
                    })
            },
            source === 'Text' ? 150 : 0
        )
        return () => {
            active = false
            clearTimeout(timer)
        }
    }, [
        left,
        right,
        target,
        source,
        textLeft,
        textRight,
        saved,
        a?.timestamp,
        b?.timestamp,
        a?.state,
        b?.state
    ])
    useEffect(() => {
        if (
            source !== 'Captured requests' ||
            saved ||
            !a ||
            !b ||
            a.state === 'pending' ||
            a.state === 'paused' ||
            b.state === 'pending' ||
            b.state === 'paused'
        )
            return
        const timer = setTimeout(
            () => void run(async () => setPairs(await window.fluxy.diffRecord(a.id, b.id))),
            400
        )
        return () => clearTimeout(timer)
    }, [left, right, source, saved, a?.state, b?.state])
    const exportDiff = () =>
        run(async () => {
            const path = await window.fluxy.diffExport(
                source === 'Text' ? { textLeft, textRight } : { left, right, target, saved }
            )
            if (path) setNotice(`Exported ${path}`)
        })
    const assign = (side: 'left' | 'right', id: string) => {
        setSaved(undefined)
        ;(side === 'left' ? setLeft : setRight)(id)
    }
    const changed =
        result?.sections
            .map((s, i) => (s.lines.some((l) => l.type !== 'unchanged') ? i : -1))
            .filter((i) => i >= 0) ?? []
    const navigate = (direction: number) => {
        const nodes = viewer.current?.querySelectorAll<HTMLElement>('[data-diff-change="true"]')
        if (!nodes?.length) return
        const next =
            jump < 0
                ? direction > 0
                    ? 0
                    : nodes.length - 1
                : (jump + direction + nodes.length) % nodes.length
        setJump(next)
        nodes[next]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    return (
        <div className="diff-workspace">
            <aside className="diff-history">
                <h4>Compare History</h4>
                {pairs.map((pair) => (
                    <div key={pair.id} className={saved === pair.id ? 'active' : ''}>
                        <button
                            onClick={() => {
                                setLeft(pair.left.id)
                                setRight(pair.right.id)
                                setSaved(pair.id)
                                setSource('Captured requests')
                            }}
                        >
                            {pair.pinned ? '★ ' : ''}
                            {pair.name}
                        </button>
                        <div className="button-row">
                            <button
                                aria-label={`Pin comparison ${pair.name}`}
                                onClick={() =>
                                    void run(async () =>
                                        setPairs(
                                            await window.fluxy.diffHistoryChange(pair.id, {
                                                pinned: !pair.pinned
                                            })
                                        )
                                    )
                                }
                            >
                                {pair.pinned ? 'Unpin' : 'Pin'}
                            </button>
                            <button
                                aria-label={`Delete comparison ${pair.name}`}
                                onClick={() =>
                                    void run(async () => {
                                        setPairs(
                                            await window.fluxy.diffHistoryChange(pair.id, {
                                                remove: true
                                            })
                                        )
                                        if (saved === pair.id) setSaved(undefined)
                                    })
                                }
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                ))}
                {!pairs.length && (
                    <p className="muted">Compared requests are saved here. Pin up to 10 pairs.</p>
                )}
            </aside>
            <div className="settings-form diff-view" ref={viewer}>
                <div className="button-row">
                    <label>
                        Source
                        <select
                            aria-label="Diff source"
                            value={source}
                            onChange={(e) => setSource(e.target.value)}
                        >
                            <option>Captured requests</option>
                            <option>Text</option>
                        </select>
                    </label>
                    <button
                        onClick={() => {
                            setSaved(undefined)
                            setLeft(right)
                            setRight(left)
                            setTextLeft(textRight)
                            setTextRight(textLeft)
                        }}
                    >
                        Swap
                    </button>
                    <button disabled={!result} onClick={() => void exportDiff()}>
                        Export Diff
                    </button>
                </div>
                {source === 'Text' ? (
                    <div className="diff-text-inputs">
                        <label>
                            Side A
                            <textarea
                                aria-label="Diff Side A"
                                rows={8}
                                maxLength={2 * 1024 * 1024}
                                value={textLeft}
                                onChange={(e) => setTextLeft(e.target.value)}
                            />
                        </label>
                        <label>
                            Side B
                            <textarea
                                aria-label="Diff Side B"
                                rows={8}
                                maxLength={2 * 1024 * 1024}
                                value={textRight}
                                onChange={(e) => setTextRight(e.target.value)}
                            />
                        </label>
                    </div>
                ) : (
                    <>
                        <div className="button-row">
                            {(
                                [
                                    ['First request', left, 'left'],
                                    ['Second request', right, 'right']
                                ] as const
                            ).map(([label, id, side]) => (
                                <label key={label}>
                                    {label}
                                    <select
                                        aria-label={label}
                                        value={id}
                                        onChange={(e) => assign(side, e.target.value)}
                                    >
                                        <option value="">Choose request</option>
                                        {candidates.map((t) => (
                                            <option key={t.id} value={t.id}>
                                                {t.method} {t.url}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                            ))}
                        </div>
                        {saved && (
                            <p className="muted">
                                Viewing a saved snapshot. History retains up to 512 KB per body.
                            </p>
                        )}
                        <details className="diff-candidates">
                            <summary>Candidate pool · {candidates.length}</summary>
                            <input
                                aria-label="Search comparison candidates"
                                placeholder="Filter URL or method"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                            />
                            <div className="diff-candidate-table">
                                <table>
                                    <thead>
                                        <tr>
                                            <th>Left</th>
                                            <th>Right</th>
                                            <th>Method</th>
                                            <th>URL</th>
                                            <th>Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {candidates
                                            .filter((t) =>
                                                (t.method + ' ' + t.url)
                                                    .toLowerCase()
                                                    .includes(query.toLowerCase())
                                            )
                                            .slice(0, 200)
                                            .map((t) => (
                                                <tr key={t.id}>
                                                    <td>
                                                        <button
                                                            aria-label={`Assign left ${t.url}`}
                                                            onClick={() => assign('left', t.id)}
                                                        >
                                                            {left === t.id ? '●' : 'L'}
                                                        </button>
                                                    </td>
                                                    <td>
                                                        <button
                                                            aria-label={`Assign right ${t.url}`}
                                                            onClick={() => assign('right', t.id)}
                                                        >
                                                            {right === t.id ? '●' : 'R'}
                                                        </button>
                                                    </td>
                                                    <td>{t.method}</td>
                                                    <td>{t.url}</td>
                                                    <td>{t.status ?? '—'}</td>
                                                </tr>
                                            ))}
                                    </tbody>
                                </table>
                            </div>
                        </details>
                        {followUp && (
                            <div className="button-row">
                                <select
                                    aria-label="Diff action side"
                                    value={actionSide}
                                    onChange={(e) => setActionSide(e.target.value)}
                                >
                                    <option value="left">Left request</option>
                                    <option value="right">Right request</option>
                                </select>
                                <select
                                    aria-label="Diff follow-up action"
                                    value=""
                                    onChange={(e) => {
                                        const t = actionSide === 'left' ? a : b
                                        if (t) followUp(e.target.value, t)
                                    }}
                                >
                                    <option value="">Follow-up action…</option>
                                    {[
                                        'Edit & Repeat',
                                        'Replay',
                                        'Map Local',
                                        'Map Remote',
                                        'Breakpoint',
                                        'Network Conditions',
                                        'Copy cURL',
                                        'Export HAR'
                                    ].map((v) => (
                                        <option key={v}>{v}</option>
                                    ))}
                                </select>
                            </div>
                        )}
                    </>
                )}
                <div className="button-row">
                    <label>
                        Compare
                        <select
                            aria-label="Diff target"
                            disabled={source === 'Text'}
                            value={target}
                            onChange={(e) => setTarget(e.target.value as DiffTarget)}
                        >
                            {['Request', 'Response', 'Timing'].map((t) => (
                                <option key={t}>{t}</option>
                            ))}
                        </select>
                    </label>
                    <label>
                        Presentation
                        <select
                            aria-label="Diff presentation"
                            value={mode}
                            onChange={(e) => setMode(e.target.value)}
                        >
                            <option>Side by Side</option>
                            <option>Unified</option>
                        </select>
                    </label>
                    <label className="check">
                        <input
                            type="checkbox"
                            checked={changesOnly}
                            onChange={(e) => setChangesOnly(e.target.checked)}
                        />
                        Changes only
                    </label>
                </div>
                {error && <p role="alert">{error}</p>}
                {notice && <p role="status">{notice}</p>}
                {source !== 'Text' && (!a || !b) ? (
                    <p>Capture or import two requests to compare.</p>
                ) : !result ? (
                    <p>Comparing…</p>
                ) : (
                    <>
                        <div className="button-row">
                            <p role="status">
                                {result.added} added · {result.removed} removed
                            </p>
                            <button disabled={!changed.length} onClick={() => navigate(-1)}>
                                Previous Difference
                            </button>
                            <button disabled={!changed.length} onClick={() => navigate(1)}>
                                Next Difference
                            </button>
                        </div>
                        <nav className="diff-section-nav">
                            {result.sections.map((s, i) => (
                                <button
                                    key={s.title}
                                    onClick={() =>
                                        sections.current[i]?.scrollIntoView({ block: 'start' })
                                    }
                                >
                                    {s.title} ·{' '}
                                    {s.lines.filter((l) => l.type !== 'unchanged').length}
                                </button>
                            ))}
                        </nav>
                        {result.sections.map((section, index) => (
                            <section
                                className="diff-section"
                                ref={(node) => {
                                    sections.current[index] = node
                                }}
                                key={section.title}
                            >
                                <h4>{section.title}</h4>
                                <div
                                    className={`diff-lines ${mode === 'Unified' ? 'unified' : 'side-by-side'}`}
                                >
                                    {section.lines
                                        .filter((l) => !changesOnly || l.type !== 'unchanged')
                                        .map((line, i) => (
                                            <div
                                                key={i}
                                                className={`diff-line ${line.type}`}
                                                data-diff-change={line.type !== 'unchanged'}
                                            >
                                                {mode === 'Unified' ? (
                                                    <>
                                                        <span>{line.oldLine ?? ''}</span>
                                                        <span>{line.newLine ?? ''}</span>
                                                        <code>
                                                            {line.type === 'added'
                                                                ? '+'
                                                                : line.type === 'removed'
                                                                  ? '-'
                                                                  : ' '}{' '}
                                                            {line.content}
                                                        </code>
                                                    </>
                                                ) : (
                                                    <>
                                                        <span>{line.oldLine ?? ''}</span>
                                                        <code>
                                                            {line.type === 'added'
                                                                ? ''
                                                                : line.content}
                                                        </code>
                                                        <span>{line.newLine ?? ''}</span>
                                                        <code>
                                                            {line.type === 'removed'
                                                                ? ''
                                                                : line.content}
                                                        </code>
                                                    </>
                                                )}
                                            </div>
                                        ))}
                                </div>
                            </section>
                        ))}
                    </>
                )}
            </div>
        </div>
    )
}
