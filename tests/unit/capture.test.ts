import { describe, expect, it, vi } from 'vitest'
import { CaptureController } from '../../src/main/capture'
import { settingsSchema } from '../../src/shared/model'

function setup() {
    const settings = settingsSchema.parse({ captureMode: 'proxy' })
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
