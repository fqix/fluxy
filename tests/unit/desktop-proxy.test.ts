import { describe, expect, it, vi } from 'vitest'
import {
    desktopProxyBackend,
    restoreDesktopProxy,
    type DesktopProxyBackend,
    type ProxyCommand,
    type ProxyValues
} from '../../src/main/desktop-proxy'

function gnomeEnvironment() {
    const entries: ProxyValues = {
        'org.gnome.system.proxy.http/host': "'old-proxy'",
        'org.gnome.system.proxy.http/port': '8080',
        'org.gnome.system.proxy.https/host': "'secure-proxy'",
        'org.gnome.system.proxy.https/port': '8443',
        'org.gnome.system.proxy.http/use-authentication': 'true',
        'org.gnome.system.proxy/use-same-proxy': 'true',
        'org.gnome.system.proxy/mode': "'auto'"
    }
    const run = vi.fn<ProxyCommand>(async (file, args) => {
        expect(file).toBe('gsettings')
        const key = `${args[1]}/${args[2]}`
        expect(key in entries).toBe(true)
        if (args[0] === 'writable') return 'true'
        if (args[0] === 'set') {
            entries[key] = args[3]
            return ''
        }
        return entries[key]
    })
    return { entries, run }
}

describe('desktop proxy backends (system commands are simulated)', () => {
    it('GNOME switches HTTP/HTTPS to manual then restores PAC mode and authentication', async () => {
        const { run } = gnomeEnvironment()
        const backend = await desktopProxyBackend(
            'linux',
            { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' },
            run
        )
        const previous = await backend.read()
        const applied = backend.target(previous, 6060)
        await backend.write(applied)
        expect(await backend.read()).toEqual(applied)
        expect(applied).toMatchObject({
            mode: "'manual'",
            httpPort: '6060',
            authentication: 'false'
        })
        await restoreDesktopProxy({ version: 1, backend: 'gnome', previous, applied }, backend)
        expect(await backend.read()).toEqual(previous)
        const writes = run.mock.calls.filter(([, args]) => args[0] === 'set')
        expect(
            writes.every(
                ([, args]) => !/password|ignore-hosts|socks|autoconfig/.test(args.join(' '))
            )
        ).toBe(true)
    })

    it('GNOME checks policy locks before writing anything', async () => {
        const { run } = gnomeEnvironment()
        const backend = await desktopProxyBackend('linux', { XDG_CURRENT_DESKTOP: 'GNOME' }, run)
        const target = backend.target(await backend.read(), 6060)
        run.mockImplementation(async (_file, args) => (args[0] === 'writable' ? 'false' : ''))
        await expect(backend.write(target)).rejects.toThrow('locked')
        expect(run.mock.calls.some(([, args]) => args[0] === 'set')).toBe(false)
    })

    it('restores an owned HTTP endpoint without overwriting a new HTTPS proxy', async () => {
        const { run, entries } = gnomeEnvironment()
        const backend = await desktopProxyBackend('linux', { XDG_CURRENT_DESKTOP: 'GNOME' }, run)
        const previous = await backend.read()
        const applied = backend.target(previous, 6060)
        await backend.write(applied)
        entries['org.gnome.system.proxy.https/host'] = "'another-app'"
        entries['org.gnome.system.proxy.https/port'] = '9090'
        await restoreDesktopProxy({ version: 1, backend: 'gnome', previous, applied }, backend)
        expect(await backend.read()).toMatchObject({
            httpHost: previous.httpHost,
            httpPort: previous.httpPort,
            httpsHost: "'another-app'",
            httpsPort: '9090',
            mode: "'manual'"
        })
    })

    it.each(['5', '6'])(
        'KDE %s uses KConfig and broadcasts the reload notification',
        async (version) => {
            const values: ProxyValues = {
                httpProxy: '',
                httpsProxy: 'http://previous:8888',
                ProxyType: '2'
            }
            const run = vi.fn<ProxyCommand>(async (file, args) => {
                if (version === '5' && file.endsWith('6')) throw new Error('not installed')
                if (args.includes('--version') || file === 'dbus-send') return ''
                const key = args[args.indexOf('--key') + 1]
                if (file.startsWith('kreadconfig')) return values[key]
                expect(args.at(-2)).toBe('--')
                values[key] = args.at(-1)!
                return ''
            })
            const backend = await desktopProxyBackend('linux', { XDG_CURRENT_DESKTOP: 'KDE' }, run)
            const previous = await backend.read(),
                applied = backend.target(previous, 6060)
            await backend.write(applied)
            expect(values).toMatchObject({ httpProxy: 'http://127.0.0.1:6060', ProxyType: '1' })
            await restoreDesktopProxy({ version: 1, backend: 'kde', previous, applied }, backend)
            expect(values).toEqual(previous)
            expect(
                run.mock.calls.filter(
                    ([file, args]) => file === 'dbus-send' && args.includes('--type=signal')
                )
            ).toHaveLength(2)
        }
    )

    it('Windows preserves PAC, auto-detect and bypass settings and uses encoded data', async () => {
        let current: ProxyValues = {
            flags: '13',
            server: 'http=old:8080;socks=127.0.0.1:7890',
            bypass: '<local>;*.corp',
            pac: "https://proxy.example/pac?x=';$value"
        }
        const run = vi.fn<ProxyCommand>(async (file, args) => {
            expect(file).toMatch(/powershell\.exe$/)
            expect(args).toContain('-NonInteractive')
            expect(args).not.toContain('-ExecutionPolicy')
            const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le')
            const encoded = script.match(/FromBase64String\('([^']+)'\)/)![1]
            const value = JSON.parse(Buffer.from(encoded, 'base64').toString())
            if (value) {
                current = value
                return ''
            }
            return JSON.stringify(current)
        })
        const backend = await desktopProxyBackend('win32', {}, run)
        const previous = await backend.read(),
            applied = backend.target(previous, 6060)
        await backend.write(applied)
        expect(current.flags).toBe('3')
        expect(current.server).toBe('http=127.0.0.1:6060;https=127.0.0.1:6060;socks=127.0.0.1:7890')
        expect(current.pac).toBe(previous.pac)
        // A bypass edit while capturing is unrelated and must survive restoration.
        current.bypass = '*.new-corp'
        await restoreDesktopProxy({ version: 1, backend: 'windows', previous, applied }, backend)
        expect(current).toEqual({ ...previous, bypass: '*.new-corp' })
    })

    it('reports unsupported Linux sessions without changing any settings', async () => {
        const run = vi.fn<ProxyCommand>()
        await expect(
            desktopProxyBackend('linux', { XDG_CURRENT_DESKTOP: 'sway' }, run)
        ).rejects.toThrow('GNOME and KDE')
        expect(run).not.toHaveBeenCalled()
    })

    it('restores a partial write and keeps failed restoration actionable', async () => {
        const previous = { flags: '9', server: '', bypass: '', pac: '' }
        const applied = {
            ...previous,
            flags: '3',
            server: 'http=127.0.0.1:6060;https=127.0.0.1:6060'
        }
        let values = { ...previous, server: applied.server }
        const backend: DesktopProxyBackend = {
            id: 'windows',
            target: () => applied,
            read: async () => ({ ...values }),
            write: vi.fn(async (next) => {
                values = next as typeof values
            })
        }
        const backup = { version: 1 as const, backend: 'windows' as const, previous, applied }
        await restoreDesktopProxy(backup, backend)
        expect(values).toEqual(previous)
        values = { ...applied }
        vi.mocked(backend.write).mockResolvedValue(undefined)
        await expect(restoreDesktopProxy(backup, backend)).rejects.toThrow('backup retained')
    })
})
