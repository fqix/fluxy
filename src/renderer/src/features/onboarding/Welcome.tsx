import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Network, ShieldCheck, Wrench } from 'lucide-react'
import {
    requiredCaptureDomainsSchema,
    type CertificateStatus,
    type Snapshot
} from '@shared/contracts/model'
import icon from '@assets/icon.png'

export function Welcome({
    snapshot,
    close,
    developerSetup
}: {
    snapshot: Snapshot
    close: () => void
    developerSetup: () => void
}) {
    const [certificate, setCertificate] = useState<CertificateStatus>()
    const [busy, setBusy] = useState('Checking system…')
    const [error, setError] = useState('')
    const [manual, setManual] = useState(false)
    const isTun = snapshot.settings.captureMode === 'tun'
    const helperReady = snapshot.helper.state === 'ready'
    const tunActive = ['starting', 'running', 'stopping'].includes(snapshot.tun.state)
    const savedDomains = snapshot.settings.tun.captureDomains.join('\n') || 'github.com\ngoogle.com'
    const [domains, setDomains] = useState(savedDomains)
    const parsedDomains = requiredCaptureDomainsSchema.safeParse(
        domains.split(/[\s,]+/).filter(Boolean)
    )
    const domainError = parsedDomains.success ? undefined : parsedDomains.error.issues[0].message
    useEffect(() => setDomains(savedDomains), [savedDomains])
    const [showOnLaunch, setShowOnLaunch] = useState(snapshot.settings.showWelcomeOnLaunch)
    useEffect(
        () => setShowOnLaunch(snapshot.settings.showWelcomeOnLaunch),
        [snapshot.settings.showWelcomeOnLaunch]
    )
    const ref = useRef<HTMLDivElement>(null)
    const pending = useRef(false)
    const act = useCallback(async (label: string, action: () => Promise<unknown>) => {
        if (pending.current) return
        pending.current = true
        setBusy(label)
        setError('')
        try {
            await action()
        } catch (e) {
            setError(String(e).replace(/^Error: Error invoking remote method '[^']+': Error: /, ''))
        } finally {
            pending.current = false
            setBusy('')
        }
    }, [])
    useEffect(() => {
        void act('Checking system…', async () =>
            setCertificate(await window.fluxy.certificateStatus())
        )
    }, [act])
    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null
        ref.current?.focus()
        return () => previous?.focus()
    }, [])
    const certificateReady =
        !!certificate?.trusted && !certificate?.browserError && !certificate?.error
    const setupReady = helperReady && certificateReady
    const completed =
        Number(helperReady) +
        Number(certificateReady) +
        Number(isTun ? snapshot.tun.state === 'running' : snapshot.running)
    const dismiss = () => {
        if (!busy) close()
    }
    const finish = (openDeveloper: boolean) =>
        void act('Saving…', async () => {
            const current = await window.fluxy.snapshot()
            const started =
                current.settings.captureMode === 'tun'
                    ? current.tun.state === 'running'
                    : current.running
            await window.fluxy.settings({
                ...current.settings,
                onboardingCompleted: true,
                autoStart: started || current.settings.autoStart
            })
            if (openDeveloper) developerSetup()
            else close()
        })
    const saveDomains = async () => {
        if (!parsedDomains.success) throw new Error(domainError)
        const current = await window.fluxy.snapshot()
        await window.fluxy.settings({
            ...current.settings,
            tun: {
                ...current.settings.tun,
                captureDomains: parsedDomains.data
            }
        })
    }
    const rows = [
        {
            title: 'Helper Setup',
            detail: 'Install the privileged helper for TUN capture and system certificate management.',
            icon: Wrench,
            done: helperReady,
            error: snapshot.helper.error,
            label: snapshot.helper.state === 'outdated' ? 'Update Helper' : 'Install Helper',
            disabled:
                tunActive ||
                snapshot.running ||
                ['unsupported', 'installing', 'uninstalling'].includes(snapshot.helper.state),
            action: () => act('Installing Helper…', () => window.fluxy.installHelper())
        },
        {
            title: 'CA Certificate',
            detail: helperReady
                ? 'Install and trust the Fluxy root CA to inspect HTTPS traffic. This requests separate system authorization.'
                : 'Install Helper first, then install and trust the Fluxy root CA for HTTPS inspection.',
            icon: ShieldCheck,
            done: certificateReady,
            error: certificate?.error || certificate?.browserError,
            label: certificate?.error
                ? 'Recheck Status'
                : certificate?.trusted
                  ? 'Retry Browser Trust'
                  : 'Install CA',
            disabled:
                !certificate ||
                (!certificate.error && !helperReady) ||
                tunActive ||
                snapshot.running,
            action: () =>
                act('Installing CA certificate…', async () => {
                    try {
                        if (!certificate?.error) await window.fluxy.trustCertificate()
                    } finally {
                        setCertificate(await window.fluxy.certificateStatus())
                    }
                })
        },
        {
            capture: true,
            title: isTun ? 'TUN Capture' : 'Socks Proxy',
            detail: isTun
                ? 'Capture selected domains across apps. Complete Helper and CA setup above, then enable TUN.'
                : 'Connect your app to Fluxy’s local SOCKS5 endpoint to capture HTTP and HTTPS traffic. HTTPS inspection requires trusting the root certificate. Supports TCP; UDP relay is not available.',
            icon: Network,
            done:
                snapshot.settings.captureMode === 'tun'
                    ? snapshot.tun.state === 'running'
                    : snapshot.running,
            label: 'Enable',
            disabled: isTun
                ? !setupReady || tunActive || snapshot.running || !!domainError
                : !certificate || snapshot.running || tunActive,
            action: () =>
                act(isTun ? 'Starting TUN…' : 'Starting SOCKS5 proxy…', async () => {
                    if (isTun) {
                        await saveDomains()
                        await window.fluxy.start()
                    } else {
                        const current = await window.fluxy.snapshot()
                        await window.fluxy.settings({
                            ...current.settings,
                            captureMode: 'proxy',
                            autoSystemProxy: false
                        })
                        await window.fluxy.start()
                    }
                    const current = await window.fluxy.snapshot()
                    const started =
                        current.settings.captureMode === 'tun'
                            ? current.tun.state === 'running'
                            : current.running
                    if (started)
                        await window.fluxy.settings({ ...current.settings, autoStart: true })
                    setCertificate(await window.fluxy.certificateStatus())
                })
        }
    ]
    return (
        <div className="modal-scrim welcome-scrim">
            <div
                className="welcome-window"
                ref={ref}
                role="dialog"
                aria-modal="true"
                aria-labelledby="welcome-title"
                tabIndex={-1}
                onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                        e.stopPropagation()
                        dismiss()
                    }
                    if (e.key !== 'Tab') return
                    const items = Array.from(
                        ref.current?.querySelectorAll<HTMLElement>(
                            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled)'
                        ) ?? []
                    )
                    const index = items.indexOf(document.activeElement as HTMLElement)
                    if (e.shiftKey && index <= 0) {
                        e.preventDefault()
                        items.at(-1)?.focus()
                    } else if (!e.shiftKey && (index === items.length - 1 || index === -1)) {
                        e.preventDefault()
                        items[0]?.focus()
                    }
                }}
            >
                <header className="welcome-header">
                    <div className="welcome-brand">
                        <img src={icon} alt="" />
                        <div>
                            <h1 id="welcome-title">Welcome to Fluxy</h1>
                            <p>
                                {snapshot.settings.onboardingCompleted
                                    ? 'Review the three setup steps before continuing.'
                                    : 'Complete these three steps to prepare network debugging.'}
                            </p>
                        </div>
                    </div>
                    <div className="welcome-progress">
                        <progress aria-label="Setup progress" max={3} value={completed} />
                        <span role="status">{busy || `${completed} of 3 complete`}</span>
                    </div>
                </header>
                <div className="welcome-content">
                    <ol className="welcome-steps">
                        {rows.map((row, index) => (
                            <li key={row.title} className={row.done ? 'complete' : ''}>
                                <span
                                    className="welcome-step-icon"
                                    aria-label={row.done ? 'Completed' : `Step ${index + 1}`}
                                >
                                    {row.done ? <Check size={15} /> : <row.icon size={15} />}
                                </span>
                                <div className="welcome-step-copy">
                                    {row.capture ? (
                                        <div
                                            role="tablist"
                                            aria-label="Capture mode"
                                            className="welcome-capture-tabs"
                                            onKeyDown={(e) => {
                                                if (
                                                    ![
                                                        'ArrowLeft',
                                                        'ArrowRight',
                                                        'Home',
                                                        'End'
                                                    ].includes(e.key)
                                                )
                                                    return
                                                const tabs = Array.from(
                                                    e.currentTarget.querySelectorAll<HTMLButtonElement>(
                                                        '[role="tab"]:not(:disabled)'
                                                    )
                                                )
                                                if (!tabs.length) return
                                                e.preventDefault()
                                                const next =
                                                    e.key === 'Home'
                                                        ? tabs[0]
                                                        : e.key === 'End'
                                                          ? tabs.at(-1)!
                                                          : (tabs.find(
                                                                (tab) =>
                                                                    tab !== document.activeElement
                                                            ) ?? tabs[0])
                                                next.focus()
                                                next.click()
                                            }}
                                        >
                                            {(['tun', 'proxy'] as const).map((mode) => (
                                                <Button
                                                    key={mode}
                                                    id={`welcome-${mode}-tab`}
                                                    role="tab"
                                                    aria-selected={isTun === (mode === 'tun')}
                                                    aria-controls="welcome-capture-panel"
                                                    disabled={
                                                        !!busy ||
                                                        tunActive ||
                                                        snapshot.running ||
                                                        snapshot.systemProxy
                                                    }
                                                    onClick={() =>
                                                        void act(
                                                            'Selecting capture mode…',
                                                            async () => {
                                                                const current =
                                                                    await window.fluxy.snapshot()
                                                                await window.fluxy.settings({
                                                                    ...current.settings,
                                                                    captureMode: mode
                                                                })
                                                            }
                                                        )
                                                    }
                                                >
                                                    {mode === 'tun' ? 'TUN Capture' : 'Socks Proxy'}
                                                </Button>
                                            ))}
                                        </div>
                                    ) : (
                                        <h2>{row.title}</h2>
                                    )}
                                    <div
                                        role={row.capture ? 'tabpanel' : undefined}
                                        id={row.capture ? 'welcome-capture-panel' : undefined}
                                        aria-labelledby={
                                            row.capture
                                                ? `welcome-${isTun ? 'tun' : 'proxy'}-tab`
                                                : undefined
                                        }
                                    >
                                        <p>{row.detail}</p>
                                        {row.capture && isTun && (
                                            <div className="welcome-domains">
                                                <label htmlFor="welcome-capture-domains">
                                                    Capture domains
                                                </label>
                                                <Textarea
                                                    id="welcome-capture-domains"
                                                    aria-describedby="welcome-capture-domains-hint welcome-capture-domains-error"
                                                    aria-invalid={!!domainError}
                                                    required
                                                    rows={2}
                                                    placeholder={'example.com\napi.example.org'}
                                                    value={domains}
                                                    disabled={
                                                        !!busy || tunActive || snapshot.running
                                                    }
                                                    onChange={(e) => setDomains(e.target.value)}
                                                />
                                                <p id="welcome-capture-domains-hint">
                                                    One domain per line; subdomains included.
                                                </p>
                                                <p
                                                    id="welcome-capture-domains-error"
                                                    className="welcome-error"
                                                    aria-live="polite"
                                                >
                                                    {domainError}
                                                </p>
                                            </div>
                                        )}
                                        {row.capture && !isTun && (
                                            <div className="welcome-domains">
                                                <p>
                                                    HTTP / HTTPS / SOCKS5 · 127.0.0.1:
                                                    {snapshot.settings.port}. Configure this address
                                                    in your app; system proxy settings are not
                                                    changed.
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                    {row.error && (
                                        <p className="welcome-error" role="alert">
                                            {row.error}
                                        </p>
                                    )}
                                </div>
                                {(!row.done || row.error) && (
                                    <Button
                                        disabled={!!busy || row.disabled}
                                        onClick={() => void row.action()}
                                    >
                                        {row.label}
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ol>
                    {error && !rows.some((row) => row.error === error) && (
                        <p className="welcome-error" role="alert">
                            {error}
                        </p>
                    )}
                    <p className="muted">
                        Enabling capture also turns on auto-start. Change this in Settings.
                    </p>
                    {manual && (
                        <p className="welcome-manual">
                            Manual setup selected. Configure your app to use HTTP and HTTPS proxy
                            127.0.0.1:{snapshot.settings.port}. HTTPS inspection also requires
                            trusting the root certificate in that app. Continuing leaves unfinished
                            steps unchanged.
                        </p>
                    )}
                </div>
                <footer className="welcome-footer">
                    <label>
                        <input
                            type="checkbox"
                            checked={showOnLaunch}
                            disabled={!!busy}
                            onChange={(e) => {
                                const checked = e.target.checked
                                setShowOnLaunch(checked)
                                void act('Saving…', async () => {
                                    const current = await window.fluxy.snapshot()
                                    try {
                                        await window.fluxy.settings({
                                            ...current.settings,
                                            showWelcomeOnLaunch: checked
                                        })
                                    } catch (error) {
                                        setShowOnLaunch(current.settings.showWelcomeOnLaunch)
                                        throw error
                                    }
                                })
                            }}
                        />
                        Show on startup
                    </label>
                    <div className="welcome-buttons">
                        <Button disabled={!!busy} onClick={dismiss}>
                            Close
                        </Button>
                        {!manual && completed < 3 && (
                            <Button disabled={!!busy} onClick={() => setManual(true)}>
                                Use Manual Setup
                            </Button>
                        )}
                        {manual && (
                            <Button disabled={!!busy} onClick={() => finish(true)}>
                                Debug My App…
                            </Button>
                        )}
                        <Button
                            className="primary"
                            disabled={!!busy || (!manual && completed < 3)}
                            onClick={() => finish(false)}
                        >
                            {manual ? 'Continue Manually' : 'Get Started'}
                        </Button>
                    </div>
                </footer>
            </div>
        </div>
    )
}
