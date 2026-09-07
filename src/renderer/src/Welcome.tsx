import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, LockKeyhole, Network, ShieldCheck, Wrench } from 'lucide-react'
import type { CertificateStatus, Snapshot } from '../../shared/model'
import icon from '../../../resources/icon.png'

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
    const completed =
        Number(certificate?.generated ?? false) +
        Number(certificate?.trusted ?? false) +
        Number(snapshot.helper.state === 'ready') +
        Number(
            snapshot.settings.captureMode === 'tun'
                ? snapshot.tun.state === 'running'
                : snapshot.systemProxy
        )
    const dismiss = () => {
        if (!busy) close()
    }
    const finish = (openDeveloper: boolean) =>
        void act('Saving…', async () => {
            const current = await window.fluxy.snapshot()
            await window.fluxy.settings({ ...current.settings, onboardingCompleted: true })
            if (openDeveloper) developerSetup()
            else close()
        })
    const rows = [
        {
            title: 'Generate Root Certificate',
            detail: "Create Fluxy's local certificate authority for HTTPS inspection.",
            icon: LockKeyhole,
            done: certificate?.generated,
            label: certificate?.error ? 'Recheck Status' : 'Generate',
            disabled: !certificate,
            action: () =>
                act('Generating certificate…', async () =>
                    setCertificate(
                        await (certificate?.error
                            ? window.fluxy.certificateStatus()
                            : window.fluxy.generateCertificate())
                    )
                )
        },
        {
            title: 'Trust Root Certificate',
            detail: 'Install and trust Fluxy’s CA in the System keychain. Installs Helper Tool first if needed, using one administrator authorization.',
            icon: ShieldCheck,
            done: certificate?.trusted,
            label: certificate?.error
                ? 'Recheck Status'
                : certificate?.supported
                  ? 'Trust'
                  : 'Export',
            disabled: !certificate?.generated,
            action: () =>
                act('Checking certificate trust…', async () => {
                    if (certificate?.error) {
                        setCertificate(await window.fluxy.certificateStatus())
                        return
                    }
                    if (certificate?.supported) await window.fluxy.trustCertificate()
                    else await window.fluxy.exportCertificate()
                    setCertificate(await window.fluxy.certificateStatus())
                })
        },
        {
            title: 'Install Helper Tool',
            detail: 'Authorize installation once. TUN and system CA installation then reuse the helper without additional administrator prompts.',
            icon: Wrench,
            done: snapshot.helper.state === 'ready',
            label: snapshot.helper.state === 'outdated' ? 'Update Helper' : 'Install Helper',
            disabled: ['unsupported', 'installing', 'uninstalling'].includes(snapshot.helper.state),
            action: () => act('Installing Helper Tool…', () => window.fluxy.installHelper())
        },
        {
            title:
                snapshot.settings.captureMode === 'tun'
                    ? 'Enable TUN Capture'
                    : 'Enable System Proxy',
            detail: 'Route system network traffic through Fluxy. Capture settings are restored when capture stops.',
            icon: Network,
            done:
                snapshot.settings.captureMode === 'tun'
                    ? snapshot.tun.state === 'running'
                    : snapshot.systemProxy,
            label: 'Enable',
            disabled: !certificate?.supported,
            action: () =>
                act('Enabling system proxy…', async () => {
                    if (snapshot.settings.captureMode === 'tun') await window.fluxy.start()
                    else await window.fluxy.systemProxy(true)
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
                            'button:not(:disabled), input:not(:disabled)'
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
                                    ? 'Review the four setup steps before continuing.'
                                    : 'Complete these four steps to prepare network debugging.'}
                            </p>
                        </div>
                    </div>
                    <div className="welcome-progress">
                        <progress aria-label="Setup progress" max={4} value={completed} />
                        <span role="status">{busy || `${completed} of 4 complete`}</span>
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
                                    <h2>{row.title}</h2>
                                    <p>{row.detail}</p>
                                    {index === 0 && certificate?.error && (
                                        <p className="welcome-error" role="alert">
                                            {certificate.error}
                                        </p>
                                    )}
                                </div>
                                {(!row.done || (index === 0 && certificate?.error)) && (
                                    <button
                                        disabled={!!busy || row.disabled}
                                        onClick={() => void row.action()}
                                    >
                                        {row.label}
                                    </button>
                                )}
                            </li>
                        ))}
                    </ol>
                    {error && (
                        <p className="welcome-error" role="alert">
                            {error}
                        </p>
                    )}
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
                        <button disabled={!!busy} onClick={dismiss}>
                            Close
                        </button>
                        {!manual && completed < 4 && (
                            <button disabled={!!busy} onClick={() => setManual(true)}>
                                Use Manual Setup
                            </button>
                        )}
                        {manual && (
                            <button disabled={!!busy} onClick={() => finish(true)}>
                                Debug My App…
                            </button>
                        )}
                        <button
                            className="primary"
                            disabled={!!busy || (!manual && completed < 4)}
                            onClick={() => finish(false)}
                        >
                            {manual ? 'Continue Manually' : 'Get Started'}
                        </button>
                    </div>
                </footer>
            </div>
        </div>
    )
}
