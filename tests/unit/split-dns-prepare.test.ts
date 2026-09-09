import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const discovery = vi.hoisted(() => vi.fn())
vi.mock('../../src/main/tun/proxy-discovery', () => ({ discoverProxyProcesses: discovery }))
vi.mock('node:child_process', () => ({
    execFile: (...args: unknown[]) =>
        (args.at(-1) as Function)(null, { stdout: '198.18/16 utun1024\n', stderr: '' })
}))
vi.mock('node:fs/promises', () => ({ readFile: async () => 'nameserver 192.0.2.53\n' }))
import { prepareSplitDNS } from '../../src/main/tun/split-dns'

describe('domain capture preparation', () => {
    beforeEach(() => {
        discovery.mockReset().mockResolvedValue([])
        vi.stubGlobal('process', { ...process, platform: 'darwin' })
    })
    afterEach(() => vi.unstubAllGlobals())
    it('enables selected domains even without an external proxy and needs no coexistence dialog', async () => {
        const prompt = vi.fn()
        expect(
            await prepareSplitDNS(new AbortController().signal, prompt, ['Example.com'])
        ).toEqual({ ipv4Range: '198.19.0.0/16', server: '192.0.2.53', domains: ['example.com'] })
        expect(prompt).not.toHaveBeenCalled()
    })
    it.each([{ domains: [] }, { domains: [''] }, { domains: ['https://example.com'] }])(
        'rejects missing or invalid domains before discovery and prompting: $domains',
        async ({ domains }) => {
            const prompt = vi.fn()
            await expect(
                prepareSplitDNS(new AbortController().signal, prompt, domains)
            ).rejects.toThrow()
            expect(discovery).not.toHaveBeenCalled()
            expect(prompt).not.toHaveBeenCalled()
        }
    )
    it('cancels scoped capture before changing transport when the coexistence dialog is dismissed', async () => {
        discovery.mockResolvedValue([{ name: 'Mihomo', pid: 123 }])
        const prompt = vi.fn(async () => ({ response: 1, checkboxChecked: false }))
        expect(
            await prepareSplitDNS(new AbortController().signal, prompt, ['example.com'])
        ).toBeNull()
        expect(prompt.mock.calls[0]).toBeDefined()
    })
    it('does not prepare selected-domain capture after cancellation', async () => {
        const controller = new AbortController()
        controller.abort()
        expect(await prepareSplitDNS(controller.signal, vi.fn(), ['example.com'])).toBeNull()
    })
    it('rediscovers DNS and routes without prompting when restoring the saved TUN mode', async () => {
        discovery.mockResolvedValue([{ name: 'Mihomo', pid: 123 }])
        const prompt = vi.fn()
        expect(
            await prepareSplitDNS(new AbortController().signal, prompt, ['example.com'], {
                interactive: false
            })
        ).toEqual({ ipv4Range: '198.19.0.0/16', server: '192.0.2.53', domains: ['example.com'] })
        expect(discovery).toHaveBeenCalled()
        expect(prompt).not.toHaveBeenCalled()
    })
})
