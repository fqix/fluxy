import { describe, it, expect, vi } from 'vitest'
const run = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => run(...args) }))
import { routeInterface } from '../../src/main/tun/tun-platform'
describe('native route discovery', () => {
    it.each([
        ['darwin', 'interface: en0\n', 'en0', '/sbin/route'],
        ['linux', '[{"dev":"eth0"}]', 'eth0', 'ip'],
        ['win32', '"以太网 2"', '以太网 2', 'powershell.exe']
    ] as const)('resolves the %s exit interface', async (platform, stdout, expected, command) => {
        // promisify(execFile) expects its Node custom result wrapper.
        run.mockImplementation((...args: unknown[]) =>
            (args.at(-1) as Function)(null, { stdout, stderr: '' })
        )
        expect(await routeInterface('default', platform)).toBe(expected)
        expect(run.mock.calls.at(-1)?.[0]).toBe(command)
    })
    it('rejects unbounded destinations before launching commands', async () => {
        run.mockClear()
        await expect(routeInterface("1.1.1.1'; evil", 'win32')).rejects.toThrow(
            'Invalid route probe'
        )
        expect(run).not.toHaveBeenCalled()
    })
    it('fails closed for a missing route', async () => {
        run.mockImplementation((...args: unknown[]) =>
            (args.at(-1) as Function)(null, { stdout: '[]', stderr: '' })
        )
        await expect(routeInterface('default', 'linux')).rejects.toThrow('Cannot resolve')
    })
})
