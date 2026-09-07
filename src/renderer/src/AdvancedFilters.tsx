import { useEffect, useState, useRef } from 'react'
import {
    activeFilterRules,
    filterFields,
    filterOperators,
    filterError,
    type FilterRule
} from '../../shared/filters'
import type { Transaction } from '../../shared/model'
export function AdvancedFilters({
    rules,
    change
}: {
    rules: FilterRule[]
    change: (rules: FilterRule[]) => void
}) {
    const update = (id: string, patch: Partial<FilterRule>) =>
        change(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    return (
        <div className="filter-builder" aria-label="Advanced filter rules">
            {rules.map((r, i) => (
                <div className="filter-row" key={r.id}>
                    <input
                        aria-label={`Enable filter ${i + 1}`}
                        type="checkbox"
                        checked={r.isEnabled}
                        onChange={(e) => update(r.id, { isEnabled: e.target.checked })}
                    />
                    <select
                        aria-label={`Filter ${i + 1} connector`}
                        disabled={i === 0}
                        value={r.connector}
                        onChange={(e) =>
                            update(r.id, { connector: e.target.value as FilterRule['connector'] })
                        }
                    >
                        <option value="and">AND</option>
                        <option value="or">OR</option>
                    </select>
                    <select
                        aria-label={`Filter ${i + 1} field`}
                        value={r.field}
                        onChange={(e) =>
                            update(r.id, { field: e.target.value as FilterRule['field'] })
                        }
                    >
                        {Object.entries(filterFields).map(([key, label]) => (
                            <option key={key} value={key}>
                                {label}
                            </option>
                        ))}
                    </select>
                    <select
                        aria-label={`Filter ${i + 1} operator`}
                        value={r.operator}
                        onChange={(e) =>
                            update(r.id, { operator: e.target.value as FilterRule['operator'] })
                        }
                    >
                        {Object.entries(filterOperators).map(([key, label]) => (
                            <option key={key} value={key}>
                                {label}
                            </option>
                        ))}
                    </select>
                    <input
                        aria-label={`Filter ${i + 1} value`}
                        value={r.value}
                        maxLength={10000}
                        onChange={(e) => update(r.id, { value: e.target.value })}
                    />
                    <button
                        aria-label={`Move filter ${i + 1} up`}
                        disabled={i === 0}
                        onClick={() => {
                            const next = [...rules]
                            ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
                            change(next)
                        }}
                    >
                        ↑
                    </button>
                    <button
                        aria-label={`Remove filter ${i + 1}`}
                        onClick={() => change(rules.filter((v) => v.id !== r.id))}
                    >
                        ×
                    </button>
                    {filterError(r) && <span role="alert">{filterError(r)}</span>}
                </div>
            ))}
            <button
                disabled={rules.length >= 100}
                onClick={() =>
                    change([
                        ...rules,
                        {
                            id: crypto.randomUUID(),
                            isEnabled: true,
                            connector: 'and',
                            field: 'url',
                            operator: 'contains',
                            value: ''
                        }
                    ])
                }
            >
                Add Condition
            </button>
            <span className="muted">
                Conditions combine from top to bottom. Empty and disabled rows are ignored.
            </span>
        </div>
    )
}
export function useAdvancedFilter(
    transactions: Transaction[],
    rules: FilterRule[],
    visible: boolean
) {
    const [result, setResult] = useState<{ ids?: Set<string>; error?: string }>({})
    const key = JSON.stringify(activeFilterRules(rules, visible))
    const latest = useRef(transactions)
    latest.current = transactions
    const request = useRef<() => void>(() => {})
    useEffect(() => {
        const active = JSON.parse(key) as FilterRule[]
        if (!active.length) {
            setResult({})
            request.current = () => {}
            return
        }
        setResult({ ids: new Set() })
        const worker = new Worker(new URL('./filter.worker.ts', import.meta.url), {
            type: 'module'
        })
        let busy = false,
            failed = false,
            sent: Transaction[] | undefined,
            timeout: ReturnType<typeof setTimeout>
        const fail = (error: string) => {
            failed = true
            clearTimeout(timeout)
            worker.terminate()
            setResult({ ids: new Set(), error })
        }
        const send = () => {
            if (busy || failed || sent === latest.current) return
            busy = true
            sent = latest.current
            timeout = setTimeout(
                () =>
                    fail(
                        'Filtering exceeded its time limit. Simplify the regular expression or reduce the captured data.'
                    ),
                3000
            )
            worker.postMessage({ transactions: sent, rules: active })
        }
        worker.onmessage = ({ data }: MessageEvent<string[]>) => {
            clearTimeout(timeout)
            busy = false
            setResult({ ids: new Set(data) })
            // Finish in-flight work and coalesce new traffic, so sustained capture cannot starve filtering.
            send()
        }
        worker.onerror = () => fail('Filter evaluation failed')
        request.current = send
        send()
        return () => {
            clearTimeout(timeout)
            worker.terminate()
            request.current = () => {}
        }
    }, [key])
    useEffect(() => request.current(), [transactions, key])
    return {
        ids: key === '[]' ? undefined : (result.ids ?? new Set<string>()),
        error: key === '[]' ? undefined : result.error
    }
}
