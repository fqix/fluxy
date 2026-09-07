import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { Store } from '../../src/main/store'
import { SystemProxy } from '../../src/main/system-proxy'
import * as desktop from '../../src/main/desktop-proxy'

vi.mock('node:child_process', async (original) => ({
    ...(await original<typeof import('node:child_process')>()),
    spawn: vi.fn(() => Object.assign(new EventEmitter(), { unref: vi.fn(), kill: vi.fn() }))
}))
let directory: string
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fluxy-system-proxy-unit-'))
})
afterEach(async () => {
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
})

describe('system proxy backup lifecycle', () => {
    it.each(['win32', 'linux'] as const)(
        '%s writes a backup before mutation and recovers it after restart',
        async (platform) => {
            const store = new Store(directory)
            const initial: desktop.ProxyValues =
                platform === 'win32'
                    ? {
                          server: 'http=old:8080',
                          flags: '9',
                          bypass: '<local>',
                          pac: 'https://corp/pac'
                      }
                    : { httpProxy: 'http://old:8080', httpsProxy: '', ProxyType: '2' }
            let current: desktop.ProxyValues = { ...initial }
            const backend: desktop.DesktopProxyBackend = {
                id: platform === 'win32' ? 'windows' : 'kde',
                read: async () => ({ ...current }),
                target: (previous) =>
                    platform === 'win32'
                        ? {
                              ...previous,
                              server: 'http=127.0.0.1:6060;https=127.0.0.1:6060',
                              flags: '3'
                          }
                        : {
                              ...previous,
                              httpProxy: 'http://127.0.0.1:6060',
                              httpsProxy: 'http://127.0.0.1:6060',
                              ProxyType: '1'
                          },
                write: async (next) => {
                    await access(join(directory, 'system-proxy-backup.json'))
                    current = { ...next }
                }
            }
            vi.spyOn(desktop, 'desktopProxyBackend').mockResolvedValue(backend)
            const proxy = new SystemProxy(store, platform)
            await proxy.set(true)
            expect(proxy.enabled).toBe(true)
            expect(current).not.toEqual(initial)
            const restarted = new SystemProxy(store, platform)
            await restarted.recover()
            expect(current).toEqual(initial)
            expect(restarted.enabled).toBe(false)
            await expect(access(join(directory, 'system-proxy-backup.json'))).rejects.toThrow()
        }
    )

    it('keeps a failed macOS rollback owned and retries restoration on Stop', async () => {
        const proxy = new SystemProxy(new Store(directory), 'darwin')
        const values = {
            webproxy: { server: 'old', port: '8080', enabled: true },
            securewebproxy: { server: 'secure', port: '8443', enabled: false }
        }
        let failRestore = true
        const command = vi.spyOn(
            proxy as unknown as { command(args: string[]): Promise<string> },
            'command'
        )
        command.mockImplementation(async (args) => {
            if (args[0] === '-listallnetworkservices') return 'Services\nWi-Fi\n'
            const match = args[0].match(/^-(get|set)(webproxy|securewebproxy)(state)?$/)!
            const item = values[match[2] as keyof typeof values]
            if (match[1] === 'get')
                return `Enabled: ${item.enabled ? 'Yes' : 'No'}\nServer: ${item.server}\nPort: ${item.port}\nAuthenticated Proxy Enabled: 0\n`
            if (args[0] === '-setsecurewebproxy' && args[2] === '127.0.0.1')
                throw new Error('Setup failed')
            if (failRestore && args[2] === 'old') throw new Error('Restore failed')
            if (match[3]) item.enabled = args[2] === 'on'
            else {
                item.server = args[2]
                item.port = args[3]
            }
            return ''
        })
        await expect(proxy.set(true)).rejects.toThrow('Restore failed')
        expect(proxy.enabled).toBe(true)
        await access(join(directory, 'system-proxy-backup.json'))
        failRestore = false
        await proxy.set(false)
        expect(proxy.enabled).toBe(false)
        expect(values.webproxy).toEqual({ server: 'old', port: '8080', enabled: true })
        await expect(access(join(directory, 'system-proxy-backup.json'))).rejects.toThrow()
    })
})
