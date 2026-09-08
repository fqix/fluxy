import { beforeEach, describe, expect, it, vi } from 'vitest'
const choose = vi.hoisted(() => vi.fn())
vi.mock('node:crypto', () => ({ randomInt: choose }))
import { tunInterfaceName, unusedTunInterfaceName } from '../../src/main/tun/tun-platform'

describe('TUN interface allocation', () => {
    beforeEach(() => choose.mockReset())

    it('accepts the highest macOS interface unit and rejects the failing range', () => {
        expect(tunInterfaceName(32767, 'darwin')).toBe('utun32767')
        for (const number of [32768, 59999, -1, 1.5, NaN])
            expect(() => tunInterfaceName(number, 'darwin')).toThrow('Invalid TUN interface')
    })

    it('bounds random selection to the XNU limit', () => {
        choose.mockImplementation((_min: number, max: number) => max - 1)
        expect(unusedTunInterfaceName([], 'darwin')).toBe('utun32767')
        expect(choose).toHaveBeenCalledWith(2000, 32768)
    })

    it('wraps within the valid range when the chosen name is already in use', () => {
        choose.mockReturnValue(32767)
        expect(unusedTunInterfaceName(['utun32767', 'utun2000'], 'darwin')).toBe('utun2001')
    })

    it('reports exhaustion instead of looping forever', () => {
        choose.mockReturnValue(2000)
        const names = Array.from({ length: 32768 - 2000 }, (_, i) => `utun${i + 2000}`)
        expect(() => unusedTunInterfaceName(names, 'darwin')).toThrow('No unused TUN')
    })

    it.each(['linux', 'win32'] as const)('retains the %s naming range', (platform) => {
        choose.mockImplementation((_min: number, max: number) => max - 1)
        expect(unusedTunInterfaceName([], platform)).toBe('fluxy59999')
        expect(choose).toHaveBeenCalledWith(2000, 60000)
    })
})
