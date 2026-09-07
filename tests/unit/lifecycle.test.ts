import { describe, expect, it, vi } from 'vitest'
import { stopServices } from '../../src/main/app/lifecycle'

describe('partial startup cleanup', () => {
    it('handles quitting before any services exist', async () => {
        expect(await stopServices({})).toEqual([])
    })
    it('stops initialized services without requiring TUN or MCP', async () => {
        const stop = vi.fn(),
            close = vi.fn()
        expect(await stopServices({ engine: { stop }, helper: { close } })).toEqual([])
        expect(close).toHaveBeenCalledOnce()
        expect(stop).toHaveBeenCalledOnce()
    })
    it('continues ordered cleanup after asynchronous and synchronous failures', async () => {
        const calls: string[] = []
        const errors = await stopServices({
            tun: {
                async stop() {
                    calls.push('tun')
                    throw new Error('TUN failed')
                }
            },
            helper: {
                close() {
                    calls.push('helper')
                }
            },
            systemProxy: {
                enabled: true,
                set(enabled) {
                    expect(enabled).toBe(false)
                    calls.push('systemProxy')
                    throw new Error('Restore failed')
                }
            },
            engine: {
                async stop() {
                    calls.push('engine')
                }
            },
            mcp: {
                async stop() {
                    calls.push('mcp')
                }
            },
            scripts: {
                close() {
                    calls.push('scripts')
                }
            }
        })
        expect(calls).toEqual(['tun', 'helper', 'systemProxy', 'engine', 'mcp', 'scripts'])
        expect(errors).toEqual(['TUN: TUN failed', 'System proxy: Restore failed'])
    })
    it('leaves inactive system proxy settings alone', async () => {
        const set = vi.fn()
        expect(await stopServices({ systemProxy: { enabled: false, set } })).toEqual([])
        expect(set).not.toHaveBeenCalled()
    })
})
