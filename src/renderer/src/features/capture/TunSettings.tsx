import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import type { Run } from '@/types/actions'
import { useState } from 'react'
import { Network, Play, Square } from 'lucide-react'
import { requiredCaptureDomainsSchema, type Snapshot } from '@shared/contracts/model'

export function TunSettingsPanel({
    snapshot,
    run,
    compact = false
}: {
    snapshot: Snapshot
    run: Run
    compact?: boolean
}) {
    const [domains, setDomains] = useState(snapshot.settings.tun.captureDomains.join('\n'))
    const parsedDomains = requiredCaptureDomainsSchema.safeParse(
        domains.split(/[\s,]+/).filter(Boolean)
    )
    const domainError = parsedDomains.success ? undefined : parsedDomains.error.issues[0].message
    const [saving, setSaving] = useState(false)
    const active = ['starting', 'running', 'stopping'].includes(snapshot.tun.state)
    const locked = snapshot.running || active || saving
    const isTun = snapshot.settings.captureMode === 'tun'
    const save = async (mode = snapshot.settings.captureMode) => {
        if (mode === 'tun' && domainError) throw new Error(domainError)
        setSaving(true)
        try {
            const current = await window.fluxy.snapshot()
            await window.fluxy.settings({
                ...current.settings,
                captureMode: mode,
                tun: {
                    ...current.settings.tun,
                    interface: '',
                    socksPort: 0,
                    routeCIDRs: [],
                    captureDomains: domains.split(/[\s,]+/).filter(Boolean)
                }
            })
        } finally {
            setSaving(false)
        }
    }
    return (
        <div className={compact ? 'tun-settings' : 'settings-form tun-settings'}>
            {!compact && (
                <h3>
                    <Network size={17} /> TUN Mode
                </h3>
            )}
            <label>
                Capture mode
                <select
                    aria-label="Capture mode"
                    disabled={locked}
                    value={snapshot.settings.captureMode}
                    onChange={(e) => {
                        const captureMode = e.target.value as 'proxy' | 'tun'
                        void run(async () => {
                            const current = await window.fluxy.snapshot()
                            await window.fluxy.settings({ ...current.settings, captureMode })
                        })
                    }}
                >
                    <option value="proxy">HTTP Proxy</option>
                    <option value="tun">TUN · all applications</option>
                </select>
            </label>
            {!isTun && (
                <>
                    <label className="check">
                        <input
                            type="checkbox"
                            checked={snapshot.settings.autoSystemProxy}
                            disabled={locked}
                            onChange={(e) => {
                                const autoSystemProxy = e.target.checked
                                void run(async () => {
                                    const current = await window.fluxy.snapshot()
                                    await window.fluxy.settings({
                                        ...current.settings,
                                        autoSystemProxy
                                    })
                                })
                            }}
                        />
                        Automatically set system proxy when capture starts
                    </label>
                    <p className="muted">
                        HTTP and HTTPS proxies point to Fluxy after its listener is ready. Stop or
                        quit to restore the previous settings. Turn this off for manual client
                        setup.
                    </p>
                </>
            )}
            {isTun && (
                <>
                    <p className="muted">
                        Capture traffic from apps that ignore HTTP proxy settings. Helper Tool
                        requests administrator authorization once when installed or updated.
                        Subsequent TUN starts and CA installation reuse it. HTTPS inspection uses
                        your SSL Proxying rules and still requires certificate trust. When automatic
                        startup is enabled, Fluxy restores this mode and its saved capture domains
                        on launch.
                    </p>
                    <HelperPanel snapshot={snapshot} run={run} compact />
                    <label>
                        Capture domains
                        <Textarea
                            aria-label="TUN capture domains"
                            aria-invalid={!!domainError}
                            aria-describedby="tun-capture-domains-hint tun-capture-domains-error"
                            required
                            rows={3}
                            placeholder={'example.com\napi.example.net'}
                            disabled={locked}
                            value={domains}
                            onChange={(e) => setDomains(e.target.value)}
                        />
                    </label>
                    <p className="muted" id="tun-capture-domains-hint">
                        Required. Enter at least one domain, one per line. Subdomains are included.
                        Use domain names without a URL, IP address, port or path.
                    </p>
                    <p className="welcome-error" id="tun-capture-domains-error" aria-live="polite">
                        {domainError}
                    </p>
                    <div className="tun-status" role="status">
                        <span
                            className={`dot ${snapshot.tun.state === 'running' ? 'green' : ''}`}
                        />
                        TUN: {snapshot.tun.state}
                        {snapshot.tun.splitDNS ? ' · Split DNS / Fake IP' : ''}
                        {snapshot.tun.interfaceName ? ` · ${snapshot.tun.interfaceName}` : ''}
                    </div>
                    {snapshot.tun.error && (
                        <p className="welcome-error" role="alert">
                            {snapshot.tun.error}
                        </p>
                    )}
                    <div className="button-row">
                        <Button
                            disabled={locked || !!domainError}
                            onClick={() => void run(() => save(), 'TUN settings saved')}
                        >
                            Save TUN Settings
                        </Button>
                        {active || snapshot.running ? (
                            <Button
                                disabled={saving || snapshot.tun.state === 'stopping'}
                                onClick={() => void run(() => window.fluxy.stop())}
                            >
                                <Square size={13} />
                                Stop TUN
                            </Button>
                        ) : (
                            <Button
                                className="primary"
                                disabled={saving || !snapshot.tun.available || !!domainError}
                                onClick={() =>
                                    void run(async () => {
                                        await save()
                                        await window.fluxy.start()
                                    })
                                }
                            >
                                <Play size={13} />
                                Start TUN
                            </Button>
                        )}
                    </div>
                </>
            )}
        </div>
    )
}

export function HelperPanel({
    snapshot,
    run,
    compact = false
}: {
    snapshot: Snapshot
    run: Run
    compact?: boolean
}) {
    const [busy, setBusy] = useState(false)
    const act = (action: () => Promise<unknown>) =>
        void run(async () => {
            setBusy(true)
            try {
                await action()
            } finally {
                setBusy(false)
            }
        })
    const helper = snapshot.helper
    const changing = helper.state === 'installing' || helper.state === 'uninstalling'
    const active = ['starting', 'running', 'stopping'].includes(snapshot.tun.state)
    return (
        <div className={compact ? 'tun-settings' : 'settings-form'}>
            {!compact && <h3>Helper Tool</h3>}
            <p role="status">
                Helper: {helper.state}
                {helper.version ? ` · ${helper.version}` : ''}
            </p>
            {!compact && (
                <p className="muted">
                    Complete setup to install Helper Tool and trust Fluxy's root CA in the same
                    elevated operation on macOS. Normal TUN starts reuse the installed helper
                    without another authorization. The helper stops TUN when Fluxy disconnects.
                </p>
            )}
            {helper.error && (
                <p className="welcome-error" role="alert">
                    {helper.error}
                </p>
            )}
            <div className="button-row">
                {helper.state !== 'ready' && (
                    <Button
                        disabled={busy || active || changing || helper.state === 'unsupported'}
                        onClick={() => act(() => window.fluxy.installHelper())}
                    >
                        {helper.state === 'outdated'
                            ? 'Update Helper & CA'
                            : helper.state === 'error'
                              ? 'Repair Helper & CA'
                              : 'Set Up Helper & CA'}
                    </Button>
                )}
                <Button
                    disabled={busy || changing}
                    onClick={() => act(() => window.fluxy.helperStatus())}
                >
                    Refresh Helper Status
                </Button>
                <Button
                    disabled={
                        busy ||
                        changing ||
                        helper.state === 'missing' ||
                        helper.state === 'unsupported'
                    }
                    onClick={() => act(() => window.fluxy.uninstallHelper())}
                >
                    Uninstall Helper
                </Button>
            </div>
            {!compact && (
                <p className="muted">
                    Uninstalling stops capture and removes the helper service. Certificates and user
                    data are kept.
                </p>
            )}
        </div>
    )
}
