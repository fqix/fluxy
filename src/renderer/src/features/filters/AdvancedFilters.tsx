import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { filterFields, filterOperators, filterError, type FilterRule } from '@shared/filters'

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
                    <Input
                        aria-label={`Filter ${i + 1} value`}
                        value={r.value}
                        maxLength={10000}
                        onChange={(e) => update(r.id, { value: e.target.value })}
                    />
                    <Button
                        aria-label={`Move filter ${i + 1} up`}
                        disabled={i === 0}
                        onClick={() => {
                            const next = [...rules]
                            ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
                            change(next)
                        }}
                    >
                        ↑
                    </Button>
                    <Button
                        aria-label={`Remove filter ${i + 1}`}
                        onClick={() => change(rules.filter((v) => v.id !== r.id))}
                    >
                        ×
                    </Button>
                    {filterError(r) && <span role="alert">{filterError(r)}</span>}
                </div>
            ))}
            <Button
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
            </Button>
            <span className="muted">
                Conditions combine from top to bottom. Empty and disabled rows are ignored.
            </span>
        </div>
    )
}
