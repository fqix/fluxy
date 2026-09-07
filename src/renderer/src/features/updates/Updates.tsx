import { Button } from '@/components/ui/button'
import type { Run } from '@/types/actions'
import { useEffect, useState } from 'react'
import type { Snapshot } from '@shared/contracts/model'

export function Updates({ snapshot, run }: { snapshot: Snapshot; run: Run }) {
    const [preferences, setPreferences] = useState(snapshot.settings.updates)
    const [saving, setSaving] = useState(false)
    useEffect(
        () => setPreferences(snapshot.settings.updates),
        [
            snapshot.settings.updates.checkAutomatically,
            snapshot.settings.updates.downloadAutomatically
        ]
    )
    const save = (key: keyof typeof preferences, value: boolean) => {
        const previous = preferences
        const next = { ...preferences, [key]: value }
        setPreferences(next)
        setSaving(true)
        void run(async () => {
            try {
                await window.fluxy.settings({ ...snapshot.settings, updates: next })
            } catch (error) {
                setPreferences(previous)
                throw error
            } finally {
                setSaving(false)
            }
        })
    }
    const state = snapshot.update
    const busy = ['checking', 'downloading', 'installing'].includes(state.phase)
    return (
        <div className="settings-form">
            <h3>Fluxy Updates</h3>
            <p>Installed version: {state.currentVersion}</p>
            <p role="status">
                {
                    {
                        idle: 'Ready to check',
                        unsupported: 'Development build',
                        checking: 'Checking for updates…',
                        available: 'Update available',
                        current: 'You are up to date',
                        downloading: 'Downloading update…',
                        downloaded: 'Update downloaded and checksum verified',
                        installing: 'Preparing to install…',
                        error: 'Update failed'
                    }[state.phase]
                }
                {state.version ? ` · ${state.version}` : ''}
            </p>
            {state.checkedAt && (
                <p className="muted">Last checked: {new Date(state.checkedAt).toLocaleString()}</p>
            )}
            {state.phase === 'downloading' && (
                <>
                    <progress
                        aria-label="Update download progress"
                        max={100}
                        value={state.percent ?? 0}
                    />
                    <span>{(state.percent ?? 0).toFixed(1)}%</span>
                </>
            )}
            {state.error && <p role="alert">{state.error}</p>}
            {state.notes && <pre className="release-notes">{state.notes}</pre>}
            <div className="button-row">
                <Button
                    disabled={busy || state.phase === 'unsupported' || state.phase === 'downloaded'}
                    onClick={() => void run(() => window.fluxy.update('check'))}
                >
                    Check for Updates
                </Button>
                {(state.phase === 'available' || (state.phase === 'error' && state.version)) && (
                    <Button
                        className="primary"
                        onClick={() => void run(() => window.fluxy.update('download'))}
                    >
                        Download Update
                    </Button>
                )}
                {state.phase === 'downloading' && (
                    <Button onClick={() => void run(() => window.fluxy.update('cancel'))}>
                        Cancel Download
                    </Button>
                )}
                {state.phase === 'downloaded' && (
                    <Button
                        className="primary"
                        onClick={() => void run(() => window.fluxy.update('install'))}
                    >
                        Restart and Install
                    </Button>
                )}
            </div>
            <label className="check">
                <input
                    type="checkbox"
                    checked={preferences.checkAutomatically}
                    disabled={saving}
                    onChange={(e) => save('checkAutomatically', e.currentTarget.checked)}
                />
                Automatically check for updates
            </label>
            <label className="check">
                <input
                    type="checkbox"
                    checked={preferences.downloadAutomatically}
                    disabled={saving}
                    onChange={(e) => save('downloadAutomatically', e.currentTarget.checked)}
                />
                Automatically download updates
            </label>
            <p className="muted">
                Installation closes capture and restores network settings before restarting.
                Downloading alone does not install an update.
            </p>
        </div>
    )
}
