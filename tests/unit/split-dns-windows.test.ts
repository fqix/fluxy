import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const commands = vi.hoisted(() => vi.fn())
vi.mock('../../src/main/tun/native-windows', () => ({ nativeWindowsQuery: commands }))
vi.mock('../../src/main/tun/proxy-discovery', () => ({ discoverProxyProcesses: async () => [] }))
import { prepareSplitDNS, splitDNSResolverExists } from '../../src/main/tun/split-dns'

beforeEach(() => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    commands.mockReset()
})
afterEach(() => vi.unstubAllGlobals())
function reply(stdout: string) {
    commands.mockResolvedValue(JSON.parse(stdout))
}
describe('Windows scoped TUN DNS', () => {
    it('avoids occupied Windows routes and snapshots DNS before activation', async () => {
        reply(
            JSON.stringify({
                routes: ['0.0.0.0/0', '198.19.0.0/16'],
                servers: ['172.31.255.2', '192.0.2.53']
            })
        )
        const prompt = vi.fn()
        expect(
            await prepareSplitDNS(new AbortController().signal, prompt, ['*.Example.com'])
        ).toEqual({
            ipv4Range: '100.127.0.0/16',
            server: '192.0.2.53',
            domains: ['example.com']
        })
        expect(prompt).not.toHaveBeenCalled()
        expect(commands).toHaveBeenCalledWith('network-snapshot')
    })
    it('rejects unavailable upstream DNS and malformed route snapshots', async () => {
        reply(JSON.stringify({ routes: [], servers: ['172.31.255.2', '0.0.0.0'] }))
        await expect(
            prepareSplitDNS(new AbortController().signal, vi.fn(), ['example.com'])
        ).rejects.toThrow('DNS server')
        reply('{}')
        await expect(
            prepareSplitDNS(new AbortController().signal, vi.fn(), ['example.com'])
        ).rejects.toThrow('Windows routes')
    })
    it.each([true, false])('verifies exact owned NRPT rules: %s', async (exists) => {
        reply(JSON.stringify(exists))
        expect(await splitDNSResolverExists('fluxy2345')).toBe(exists)
        expect(commands).toHaveBeenCalledWith('dns-status', { interfaceName: 'fluxy2345' })
    })
    it('never treats invalid verification output as restored', async () => {
        reply('null')
        await expect(splitDNSResolverExists('fluxy2345')).rejects.toThrow('Cannot verify')
    })
    it('rejects injected interface names before invoking the native helper', async () => {
        await expect(splitDNSResolverExists("fluxy2345'; Remove-Item x")).rejects.toThrow('Invalid')
        expect(commands).not.toHaveBeenCalled()
    })
})
