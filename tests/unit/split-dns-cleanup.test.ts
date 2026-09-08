import { describe, expect, it, vi, afterEach } from 'vitest'
const commands = vi.hoisted(() => ({ exec: vi.fn(), end: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => commands.exec(...args) }))
import { splitDNSResolverExists, waitForSplitDNSRemoval } from '../../src/main/tun/split-dns'

afterEach(() => vi.clearAllMocks())
describe('split DNS restoration', () => {
    it('checks exactly the owning TUN resolver and accepts only confirmed absence', async () => {
        commands.exec.mockImplementation((...args: unknown[]) => {
            ;(args.at(-1) as Function)(null, '  No such key\n')
            return { stdin: { end: commands.end } }
        })
        expect(await splitDNSResolverExists('utun2345')).toBe(false)
        expect(commands.end).toHaveBeenCalledWith(
            'show State:/Network/Service/dev.fengqi.fluxy.electron.helper.utun2345/DNS\nquit\n'
        )
        expect(commands.exec.mock.calls[0][0]).toBe('/usr/sbin/scutil')
    })
    it('rejects unbounded interface names without invoking system tools', async () => {
        await expect(splitDNSResolverExists('utun2345\nremove other')).rejects.toThrow('Invalid')
        expect(commands.exec).not.toHaveBeenCalled()
    })
    it('waits until DNS is restored even if the TUN interface has already disappeared', async () => {
        const exists = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
        await waitForSplitDNSRemoval('utun2345', 1000, exists)
        expect(exists).toHaveBeenCalledTimes(2)
    })
    it('keeps failed restoration actionable and allows Stop to retry', async () => {
        const exists = vi.fn().mockResolvedValue(true)
        await expect(waitForSplitDNSRemoval('utun2345', 0, exists)).rejects.toThrow('retry Stop')
        exists.mockResolvedValue(false)
        await expect(waitForSplitDNSRemoval('utun2345', 0, exists)).resolves.toBeUndefined()
    })
    it.each(['permission denied', '', 'unexpected output'])(
        'does not treat %j as restored',
        async (output) => {
            commands.exec.mockImplementation((...args: unknown[]) => {
                ;(args.at(-1) as Function)(null, output)
                return { stdin: { end: commands.end } }
            })
            await expect(splitDNSResolverExists('utun2345')).rejects.toThrow('Cannot verify')
        }
    )
    it('propagates a failed verification command', async () => {
        commands.exec.mockImplementation((...args: unknown[]) => {
            ;(args.at(-1) as Function)(new Error('command timed out'), '')
            return { stdin: { end: commands.end } }
        })
        await expect(splitDNSResolverExists('utun2345')).rejects.toThrow('timed out')
    })
    it('recognizes a resolver that still exists', async () => {
        commands.exec.mockImplementation((...args: unknown[]) => {
            ;(args.at(-1) as Function)(
                null,
                '<dictionary> {\n ServerAddresses : <array> { 172.31.255.2 }\n}\n'
            )
            return { stdin: { end: commands.end } }
        })
        expect(await splitDNSResolverExists('utun2345')).toBe(true)
    })
})
