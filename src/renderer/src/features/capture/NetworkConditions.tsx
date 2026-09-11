import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { Run } from '@/types/actions'
import { useState } from 'react'
import { networkPresets, type NetworkPreset } from '@shared/traffic/network-conditions'
import { ruleSchema, type Rule, type Snapshot } from '@shared/contracts/model'

export function NetworkConditions({
    snapshot,
    run,
    initialURL
}: {
    snapshot: Snapshot
    run: Run
    initialURL?: string
}) {
    const fresh = () =>
        ruleSchema.parse({
            id: crypto.randomUUID(),
            enabled: false,
            kind: 'networkCondition',
            pattern: initialURL ? new URL(initialURL).origin + new URL(initialURL).pathname : '*',
            matchType: 'wildcard',
            includeSubpaths: true,
            networkPreset: 'threeG',
            ...networkPresets.threeG,
            name: 'New Network Condition'
        })
    const [draft, setDraft] = useState<Rule>(fresh),
        [query, setQuery] = useState('')
    const conditions = snapshot.rules.filter((r) => r.kind === 'networkCondition')
    const save = (value: Rule) =>
        run(
            () =>
                window.fluxy.rules([
                    ...snapshot.rules
                        .filter((r) => r.id !== value.id)
                        .map((r) =>
                            value.enabled && r.kind === 'networkCondition'
                                ? { ...r, enabled: false }
                                : r
                        ),
                    value
                ]),
            'Network condition saved'
        )
    return (
        <div className="rule-layout network-conditions">
            <aside className="rule-list">
                <Input
                    aria-label="Search network conditions"
                    placeholder="Search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
                <Button onClick={() => setDraft(fresh())}>Add Rule</Button>
                <Button
                    disabled={!conditions.some((r) => r.enabled)}
                    onClick={() =>
                        void run(() =>
                            window.fluxy.rules(
                                snapshot.rules.map((r) =>
                                    r.kind === 'networkCondition' ? { ...r, enabled: false } : r
                                )
                            )
                        )
                    }
                >
                    Disable All
                </Button>
                {conditions
                    .filter((r) =>
                        (r.name + ' ' + r.pattern).toLowerCase().includes(query.toLowerCase())
                    )
                    .map((r) => (
                        <Button
                            className={r.id === draft.id ? 'selected' : ''}
                            key={r.id}
                            onClick={() => setDraft(r)}
                        >
                            {r.name}
                            <small>
                                {r.enabled ? 'Active' : 'Inactive'} ·{' '}
                                {networkPresets[r.networkPreset ?? 'custom'].name} · {r.delay} ms
                            </small>
                        </Button>
                    ))}
            </aside>
            <div className="settings-form">
                <p>
                    One active profile. Applies request-start latency and per-connection
                    upload/download limits to inspected HTTP, HTTPS and WebSocket traffic.
                </p>
                <label>
                    Name
                    <Input
                        aria-label="Network condition name"
                        value={draft.name}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    />
                </label>
                <label className="check">
                    <input
                        aria-label="Enable network condition"
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                    />
                    Enabled (disables other profiles)
                </label>
                <label>
                    URL pattern
                    <Input
                        aria-label="Network condition pattern"
                        value={draft.pattern}
                        onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
                    />
                </label>
                <label>
                    Match
                    <select
                        aria-label="Network condition match"
                        value={draft.matchType}
                        onChange={(e) =>
                            setDraft({ ...draft, matchType: e.target.value as Rule['matchType'] })
                        }
                    >
                        <option value="wildcard">Wildcard</option>
                        <option value="regex">Regex</option>
                        <option value="legacy">Legacy wildcard</option>
                    </select>
                </label>
                {draft.matchType === 'wildcard' && (
                    <label className="check">
                        <input
                            type="checkbox"
                            checked={draft.includeSubpaths}
                            onChange={(e) =>
                                setDraft({ ...draft, includeSubpaths: e.target.checked })
                            }
                        />
                        Include subpaths
                    </label>
                )}
                <label>
                    Profile
                    <select
                        aria-label="Network condition preset"
                        value={draft.networkPreset ?? 'custom'}
                        onChange={(e) => {
                            const preset = e.target.value as NetworkPreset
                            setDraft({
                                ...draft,
                                networkPreset: preset,
                                ...networkPresets[preset],
                                name: draft.name
                            })
                        }}
                    >
                        {Object.entries(networkPresets).map(([key, p]) => (
                            <option key={key} value={key}>
                                {p.name}
                            </option>
                        ))}
                    </select>
                </label>
                {(['delay', 'uploadKbps', 'downloadKbps'] as const).map((key) => (
                    <label key={key}>
                        {key === 'delay'
                            ? 'Latency (ms)'
                            : key === 'uploadKbps'
                              ? 'Upload (kbit/s; 0 is unlimited)'
                              : 'Download (kbit/s; 0 is unlimited)'}
                        <Input
                            aria-label={`Network ${key}`}
                            type="number"
                            min={0}
                            max={key === 'delay' ? 30000 : 1000000}
                            disabled={key !== 'delay' && draft.networkPreset !== 'custom'}
                            value={draft[key]}
                            onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
                        />
                    </label>
                ))}
                <p className="muted">
                    Packet loss: 0%. Limits apply to inspected HTTP bodies, including HTTP/3. Other
                    UDP traffic and encrypted passthrough tunnels are unaffected.
                </p>
                <div className="button-row">
                    <Button
                        className="primary"
                        onClick={() =>
                            void run(async () => {
                                await save(ruleSchema.parse(draft))
                            })
                        }
                    >
                        Save Network Condition
                    </Button>
                    <Button
                        disabled={!conditions.some((r) => r.id === draft.id)}
                        onClick={() =>
                            void run(async () => {
                                await window.fluxy.rules(
                                    snapshot.rules.filter((r) => r.id !== draft.id)
                                )
                                setDraft(fresh())
                            })
                        }
                    >
                        Delete Rule
                    </Button>
                </div>
            </div>
        </div>
    )
}
