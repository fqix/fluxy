import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import type { Run } from '@/types/actions'
import { useState } from 'react'
import { Network, Play, Square } from 'lucide-react'
import type { Snapshot } from '@shared/contracts/model'

export function TunSettingsPanel({
    snapshot,
    run,
    compact = false
}: {
    snapshot: Snapshot
    run: Run
    compact?: boolean
}) {
    const [config, setConfig] = useState(snapshot.settings.tun)
    const [routes, setRoutes] = useState(config.routeCIDRs.join('\n'))
    const [saving, setSaving] = useState(false)
    const active = ['starting', 'running', 'stopping'].includes(snapshot.tun.state)
    const locked = snapshot.running || active || saving
    const isTun = snapshot.settings.captureMode === 'tun'
    const save = async (mode = snapshot.settings.captureMode) => {
        setSaving(true)
        try {
            const current = await window.fluxy.snapshot()
            await window.fluxy.settings({
                ...current.settings,
                captureMode: mode,
                tun: { ...config, routeCIDRs: routes.split(/[\s,]+/).filter(Boolean) }
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
                    onChange={(e) => void run(() => save(e.target.value as 'proxy' | 'tun'))}
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
                        your SSL Proxying rules and still requires certificate trust. TUN starts
                        only when you click Start, even if proxy auto-start is enabled.
                    </p>
                    <HelperPanel snapshot={snapshot} run={run} compact />
                    <label>
                        Exit interface
                        <select
                            aria-label="TUN exit interface"
                            disabled={locked || config.socksPort > 0}
                            value={config.interface}
                            onChange={(e) => setConfig({ ...config, interface: e.target.value })}
                        >
                            <option value="">Detect automatically</option>
                            {[
                                ...new Set([
                                    ...snapshot.networkInterfaces,
                                    ...(config.interface ? [config.interface] : [])
                                ])
                            ].map((name) => (
                                <option key={name}>{name}</option>
                            ))}
                        </select>
                    </label>
                    <label>
                        Local SOCKS5 exit port
                        <Input
                            aria-label="TUN SOCKS5 exit port"
                            type="number"
                            min={0}
                            max={65535}
                            disabled={locked}
                            value={config.socksPort}
                            onChange={(e) =>
                                setConfig({ ...config, socksPort: Number(e.target.value) })
                            }
                        />
                    </label>
                    <p className="muted">
                        Use 0 for direct interface routing. If another VPN uses Fake-IP or split
                        routes, enter its local SOCKS5 port. TUN uses this exit independently of
                        Upstream Proxy; disable Upstream Proxy before starting.
                    </p>
                    <label>
                        Route CIDRs (optional)
                        <Textarea
                            aria-label="TUN route CIDRs"
                            rows={3}
                            placeholder={'Leave empty for all destinations\n203.0.113.10/32'}
                            disabled={locked}
                            value={routes}
                            onChange={(e) => setRoutes(e.target.value)}
                        />
                    </label>
                    <p className="muted">
                        One IPv4 or IPv6 CIDR per line. UDP and non-HTTP traffic are forwarded
                        without body inspection. DNS settings are preserved.
                    </p>
                    <div className="tun-status" role="status">
                        <span
                            className={`dot ${snapshot.tun.state === 'running' ? 'green' : ''}`}
                        />
                        TUN: {snapshot.tun.state}
                        {snapshot.tun.interfaceName ? ` · ${snapshot.tun.interfaceName}` : ''}
                    </div>
                    {snapshot.tun.error && (
                        <p className="welcome-error" role="alert">
                            {snapshot.tun.error}
                        </p>
                    )}
                    <div className="button-row">
                        <Button
                            disabled={locked}
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
                                disabled={saving || !snapshot.tun.available}
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
                    Install once to enable TUN and install Fluxy's root CA in the system trust
                    store. Your operating system requests administrator authorization only for
                    installation, updates, or repair or removal. The helper stops TUN when Fluxy
                    disconnects.
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
                            ? 'Update Helper'
                            : helper.state === 'error'
                              ? 'Repair Helper'
                              : 'Install Helper'}
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
