import { describe, expect, it, vi } from 'vitest'
import { CaptureController } from '../../src/main/capture/capture'
import { settingsSchema } from '../../src/shared/contracts/model'

function setup() {
    const settings = settingsSchema.parse({
        captureMode: 'proxy',
        tun: { captureDomains: ['example.com'] }
    })
    const calls: string[] = []
    const engine = {
        running: false,
        start: vi.fn(async () => {
            calls.push('listen')
            engine.running = true
        }),
        stop: vi.fn(async () => {
            calls.push('close')
            engine.running = false
        })
    }
    const tun = {
        status: { state: 'stopped' },
        start: vi.fn(async () => {
            calls.push('tun-start')
        }),
        stop: vi.fn(async () => {
            calls.push('tun-stop')
        })
    }
    const proxy = {
        enabled: false,
        set: vi.fn(async (enabled: boolean) => {
            calls.push(enabled ? 'proxy-on' : 'restore')
            proxy.enabled = enabled
        })
    }
    const capture = new CaptureController(() => settings, engine, tun, proxy)
    return { settings, calls, engine, tun, proxy, capture }
}

describe('automatic system proxy capture', () => {
    it('defaults to automatic proxy setup and restores before closing the listener', async () => {
        const { capture, calls, settings } = setup()
        expect(settings.autoSystemProxy).toBe(true)
        await capture.start()
        await capture.stop()
        expect(calls).toEqual(['listen', 'proxy-on', 'tun-stop', 'restore', 'close'])
    })

    it('never changes system settings if the listener fails', async () => {
        const { engine, proxy, capture } = setup()
        engine.start.mockRejectedValue(new Error('Port in use'))
        await expect(capture.start()).rejects.toThrow('Port in use')
        expect(proxy.set).not.toHaveBeenCalled()
    })

    it('closes a newly started listener when system setup fails and rolls back', async () => {
        const { engine, proxy, capture } = setup()
        proxy.set.mockRejectedValue(new Error('Permission denied'))
        await expect(capture.start()).rejects.toThrow('Permission denied')
        expect(engine.running).toBe(false)
        expect(engine.stop).toHaveBeenCalledOnce()
    })

    it('keeps the listener available when restoration failed, then retries on Stop', async () => {
        const { engine, proxy, capture } = setup()
        proxy.set.mockImplementationOnce(async () => {
            proxy.enabled = true
            throw new Error('Restore failed')
        })
        await expect(capture.start()).rejects.toThrow('Restore failed')
        expect(engine.running).toBe(true)
        await capture.stop()
        expect(proxy.enabled).toBe(false)
        expect(engine.running).toBe(false)
    })

    it('preserves an existing manually started listener when enabling system proxy fails', async () => {
        const { engine, proxy, capture } = setup()
        engine.running = true
        proxy.set.mockRejectedValue(new Error('Permission denied'))
        await expect(capture.setSystemProxy(true)).rejects.toThrow('Permission denied')
        expect(engine.stop).not.toHaveBeenCalled()
    })

    it('honors the saved opt-out and allows explicit system proxy control', async () => {
        const { settings, proxy, capture } = setup()
        settings.autoSystemProxy = false
        await capture.start()
        expect(proxy.set).not.toHaveBeenCalled()
        await capture.setSystemProxy(true)
        expect(proxy.enabled).toBe(true)
        await capture.setSystemProxy(false)
        expect(proxy.enabled).toBe(false)
    })

    it('does not automatically change system proxy for TUN', async () => {
        const { settings, engine, proxy, tun, capture } = setup()
        settings.captureMode = 'tun'
        await capture.start()
        expect(tun.start).toHaveBeenCalledOnce()
        expect(engine.start).not.toHaveBeenCalled()
        expect(proxy.set).not.toHaveBeenCalled()
        await expect(capture.setSystemProxy(true)).rejects.toThrow('Stop TUN')
    })

    it('serializes Stop and shutdown waiting behind pending system proxy setup', async () => {
        const { engine, proxy, capture, calls } = setup()
        let ready!: () => void
        const pending = new Promise<void>((resolve) => {
            ready = resolve
        })
        proxy.set.mockImplementationOnce(async () => {
            await pending
            calls.push('proxy-on')
            proxy.enabled = true
        })
        const start = capture.start()
        const stop = capture.stop()
        expect(capture.busy).toBe(true)
        let settled = false
        const drain = capture.settled().then(() => {
            settled = true
        })
        await vi.waitFor(() => expect(engine.start).toHaveBeenCalledOnce())
        expect(engine.stop).not.toHaveBeenCalled()
        expect(settled).toBe(false)
        ready()
        await Promise.all([start, stop, drain])
        expect(calls).toEqual(['listen', 'proxy-on', 'tun-stop', 'restore', 'close'])
        expect(settled).toBe(true)
        expect(capture.busy).toBe(false)
    })
})

describe('TUN exit preparation', () => {
    it('blocks manual and automatic startup when certificate checks fail, then allows retry', async () => {
        const { settings, engine, tun, proxy } = setup()
        settings.captureMode = 'tun'
        settings.autoStart = true
        proxy.enabled = true
        const prepare = vi
            .fn()
            .mockRejectedValue(
                new Error('Cannot start TUN: install and trust the Fluxy root certificate first.')
            )
        const capture = new CaptureController(() => settings, engine, tun, proxy, prepare)
        await expect(capture.start()).rejects.toThrow('install and trust')
        await expect(capture.restore()).rejects.toThrow('install and trust')
        expect(tun.start).not.toHaveBeenCalled()
        expect(engine.start).not.toHaveBeenCalled()
        expect(proxy.set).not.toHaveBeenCalled()
        prepare.mockResolvedValue(true)
        await capture.start()
        expect(tun.start).toHaveBeenCalledOnce()
    })
    it.each([
        { domains: [], error: 'at least one capture domain' },
        { domains: ['   '], error: 'nonempty capture domain' },
        { domains: ['example.com', 'https://example.net'], error: 'without a URL' },
        { domains: ['127.0.0.1'], error: 'without a URL' }
    ])(
        'blocks manual and automatic TUN startup for $domains before any side effects',
        async ({ domains, error }) => {
            const { settings, engine, tun, proxy } = setup()
            settings.captureMode = 'tun'
            settings.tun.captureDomains = domains
            settings.autoStart = true
            proxy.enabled = true
            const prepare = vi.fn(async () => true)
            const capture = new CaptureController(() => settings, engine, tun, proxy, prepare)
            await expect(capture.start()).rejects.toThrow(error)
            await expect(capture.restore()).rejects.toThrow(error)
            expect(prepare).not.toHaveBeenCalled()
            expect(tun.start).not.toHaveBeenCalled()
            expect(engine.start).not.toHaveBeenCalled()
            expect(proxy.set).not.toHaveBeenCalled()
            expect(settings.tun.captureDomains).toEqual(domains)
            settings.tun.captureDomains = ['example.com']
            await capture.start()
            expect(tun.start).toHaveBeenCalledOnce()
        }
    )
    it('allows HTTP proxy capture without TUN domains', async () => {
        const { settings, capture, engine } = setup()
        settings.tun.captureDomains = []
        await capture.start()
        expect(engine.running).toBe(true)
    })
    it.each(['proxy', 'tun'] as const)(
        'restores saved %s mode only when auto-start is enabled',
        async (mode) => {
            const { settings, engine, tun, proxy } = setup()
            settings.captureMode = mode
            const prepare = vi.fn(async () => true)
            const capture = new CaptureController(() => settings, engine, tun, proxy, prepare)
            await capture.restore()
            expect(engine.start).not.toHaveBeenCalled()
            expect(tun.start).not.toHaveBeenCalled()
            expect(prepare).not.toHaveBeenCalled()
            settings.autoStart = true
            await capture.restore()
            if (mode === 'tun') {
                expect(tun.start).toHaveBeenCalledOnce()
                expect(prepare).toHaveBeenCalledWith(expect.any(AbortSignal), true)
                expect(proxy.set).not.toHaveBeenCalled()
            } else {
                expect(engine.start).toHaveBeenCalledOnce()
                expect(proxy.set).toHaveBeenCalledWith(true)
                expect(prepare).not.toHaveBeenCalled()
            }
        }
    )
    it('restores a manual SOCKS/HTTP listener without changing system proxy', async () => {
        const { settings, capture, engine, proxy } = setup()
        settings.autoStart = true
        settings.autoSystemProxy = false
        await capture.restore()
        expect(engine.running).toBe(true)
        expect(proxy.set).not.toHaveBeenCalled()
    })
    it('keeps the saved mode on failed restoration and allows manual retry', async () => {
        const { settings, tun, capture } = setup()
        settings.captureMode = 'tun'
        settings.autoStart = true
        tun.start.mockRejectedValueOnce(new Error('Helper is unavailable'))
        await expect(capture.restore()).rejects.toThrow('Helper is unavailable')
        expect(settings.captureMode).toBe('tun')
        expect(settings.autoStart).toBe(true)
        await capture.start()
        expect(tun.start).toHaveBeenCalledTimes(2)
    })
    it('cancels before changing system proxy or starting TUN', async () => {
        const { settings, engine, tun, proxy } = setup()
        settings.captureMode = 'tun'
        proxy.enabled = true
        const prepare = vi.fn(async () => false)
        const capture = new CaptureController(() => settings, engine, tun, proxy, prepare)
        await capture.start()
        expect(prepare).toHaveBeenCalledOnce()
        expect(tun.start).not.toHaveBeenCalled()
        expect(proxy.set).not.toHaveBeenCalled()
    })
    it('aborts an open prompt and any queued starts when Stop is requested', async () => {
        const { settings, engine, tun, proxy } = setup()
        settings.captureMode = 'tun'
        const prepare = vi.fn(
            (signal: AbortSignal) =>
                new Promise<boolean>((resolve) => {
                    signal.addEventListener('abort', () => resolve(true), { once: true })
                })
        )
        const capture = new CaptureController(() => settings, engine, tun, proxy, prepare)
        const first = capture.start()
        const second = capture.start()
        await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
        const stop = capture.stop()
        await Promise.all([first, second, stop])
        expect(prepare.mock.calls[0][0].aborted).toBe(true)
        expect(prepare).toHaveBeenCalledOnce()
        expect(tun.start).not.toHaveBeenCalled()
        expect(tun.stop).toHaveBeenCalledOnce()
        expect(capture.busy).toBe(false)
    })
    it('serializes preparation and starts only once when already running', async () => {
        const { settings, engine, tun, proxy, calls } = setup()
        settings.captureMode = 'tun'
        proxy.enabled = true
        const prepare = vi.fn(async () => {
            calls.push('prepare')
            return true
        })
        tun.start.mockImplementation(async () => {
            calls.push('tun-start')
            tun.status.state = 'running'
        })
        const capture = new CaptureController(() => settings, engine, tun, proxy, prepare)
        await Promise.all([capture.start(), capture.start()])
        expect(calls).toEqual(['prepare', 'restore', 'tun-start'])
        expect(prepare).toHaveBeenCalledOnce()
    })
})
