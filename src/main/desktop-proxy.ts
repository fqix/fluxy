import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { z } from 'zod'
import { windowsProxyScript } from './windows-proxy'

export type ProxyValues = Record<string, string>
export type ProxyCommand = (file: string, args: string[]) => Promise<string>
const execute = promisify(execFile)
const command: ProxyCommand = async (file, args) =>
    (await execute(file, args, { timeout: 30000, windowsHide: true })).stdout.trim()
export interface DesktopProxyBackend {
    id: 'windows' | 'gnome' | 'kde'
    read(): Promise<ProxyValues>
    target(previous: ProxyValues, port: number): ProxyValues
    write(values: ProxyValues): Promise<void>
}

const gnomeKeys = [
    ['httpHost', 'org.gnome.system.proxy.http', 'host'],
    ['httpPort', 'org.gnome.system.proxy.http', 'port'],
    ['httpsHost', 'org.gnome.system.proxy.https', 'host'],
    ['httpsPort', 'org.gnome.system.proxy.https', 'port'],
    ['authentication', 'org.gnome.system.proxy.http', 'use-authentication'],
    ['sameProxy', 'org.gnome.system.proxy', 'use-same-proxy'],
    ['mode', 'org.gnome.system.proxy', 'mode']
] as const

function gnome(run: ProxyCommand): DesktopProxyBackend {
    return {
        id: 'gnome',
        async read() {
            const values: ProxyValues = {}
            for (const [id, schema, key] of gnomeKeys)
                values[id] = await run('gsettings', ['get', schema, key])
            return values
        },
        target(previous, port) {
            return {
                ...previous,
                httpHost: "'127.0.0.1'",
                httpsHost: "'127.0.0.1'",
                httpPort: String(port),
                httpsPort: String(port),
                authentication: 'false',
                sameProxy: 'false',
                mode: "'manual'"
            }
        },
        async write(values) {
            // Check policy locks before changing any value. Credentials, bypass
            // hosts, SOCKS, FTP and the saved PAC URL are never written.
            for (const [, schema, key] of gnomeKeys)
                if ((await run('gsettings', ['writable', schema, key])) !== 'true')
                    throw new Error(`System proxy setting is locked: ${schema}.${key}`)
            for (const [id, schema, key] of gnomeKeys)
                await run('gsettings', ['set', schema, key, values[id]])
        }
    }
}

async function kde(run: ProxyCommand): Promise<DesktopProxyBackend> {
    let version = ''
    for (const candidate of ['6', '5']) {
        try {
            await run(`kreadconfig${candidate}`, ['--version'])
            await run(`kwriteconfig${candidate}`, ['--version'])
            version = candidate
            break
        } catch {
            /* Try the other installed KDE generation. */
        }
    }
    if (!version) throw new Error('KDE system proxy requires kreadconfig and kwriteconfig (5 or 6)')
    // The broadcast is the same notification used by KDE's proxy settings UI.
    await run('dbus-send', [
        '--session',
        '--print-reply',
        '--dest=org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus.ListNames'
    ])
    const args = ['--file', 'kioslaverc', '--group', 'Proxy Settings']
    const keys = ['httpProxy', 'httpsProxy', 'ProxyType']
    return {
        id: 'kde',
        async read() {
            const values: ProxyValues = {}
            for (const key of keys)
                values[key] = await run(`kreadconfig${version}`, [
                    ...args,
                    '--key',
                    key,
                    '--default',
                    key === 'ProxyType' ? '0' : ''
                ])
            return values
        },
        target(previous, port) {
            return {
                ...previous,
                httpProxy: `http://127.0.0.1:${port}`,
                httpsProxy: `http://127.0.0.1:${port}`,
                ProxyType: '1'
            }
        },
        async write(values) {
            for (const key of keys)
                await run(`kwriteconfig${version}`, [...args, '--key', key, '--', values[key]])
            await run('dbus-send', [
                '--session',
                '--type=signal',
                '/KIO/Scheduler',
                'org.kde.KIO.Scheduler.reparseSlaveConfiguration',
                'string:'
            ])
        }
    }
}

function windows(run: ProxyCommand, env: NodeJS.ProcessEnv): DesktopProxyBackend {
    const executable = join(
        env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
    )
    const invoke = (state?: ProxyValues) =>
        run(executable, [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            windowsProxyScript(state)
        ])
    return {
        id: 'windows',
        async read() {
            return z
                .object({
                    flags: z.string().regex(/^\d+$/),
                    server: z.string(),
                    bypass: z.string(),
                    pac: z.string()
                })
                .parse(JSON.parse(await invoke()))
        },
        target(previous, port) {
            // Retain protocol-specific SOCKS/FTP mappings; Fluxy only handles HTTP/HTTPS.
            const others = previous.server
                .split(';')
                .filter(
                    (entry) =>
                        /^[a-z][a-z0-9+.-]*=/i.test(entry.trim()) && !/^https?=/i.test(entry.trim())
                )
            return {
                ...previous,
                flags: '3',
                server: [`http=127.0.0.1:${port}`, `https=127.0.0.1:${port}`, ...others].join(';')
            }
        },
        async write(values) {
            await invoke(values)
        }
    }
}

export async function desktopProxyBackend(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    run: ProxyCommand = command,
    savedBackend?: DesktopProxyBackend['id']
): Promise<DesktopProxyBackend> {
    if (platform === 'win32' && (!savedBackend || savedBackend === 'windows'))
        return windows(run, env)
    if (platform === 'linux') {
        if (
            savedBackend === 'kde' ||
            (!savedBackend &&
                /kde|plasma/i.test(env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || ''))
        )
            return kde(run)
        if (savedBackend && savedBackend !== 'gnome')
            throw new Error('Proxy backup belongs to a different platform')
        if (
            !savedBackend &&
            !/gnome|unity|cinnamon|pantheon|budgie/i.test(
                env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || ''
            )
        )
            throw new Error(
                'Automatic system proxy supports GNOME and KDE desktops on Linux. Disable automatic system proxy and use Developer Setup on this desktop.'
            )
        await run('gsettings', ['get', 'org.gnome.system.proxy', 'mode'])
        return gnome(run)
    }
    throw new Error('Automatic system proxy is unavailable on this platform')
}

export const desktopProxyBackupSchema = z.object({
    version: z.literal(1),
    backend: z.enum(['windows', 'gnome', 'kde']),
    previous: z.record(z.string(), z.string()),
    applied: z.record(z.string(), z.string())
})
export type DesktopProxyBackup = z.infer<typeof desktopProxyBackupSchema>

export async function restoreDesktopProxy(
    backup: DesktopProxyBackup,
    backend?: DesktopProxyBackend
) {
    const adapter =
        backend ??
        (await desktopProxyBackend(process.platform, process.env, command, backup.backend))
    const current = await adapter.read()
    const keys = Object.keys(current)
    if (
        keys.length !== Object.keys(backup.previous).length ||
        keys.some(
            (key) =>
                typeof backup.previous[key] !== 'string' || typeof backup.applied[key] !== 'string'
        )
    )
        throw new Error('Invalid system proxy backup')
    const groups =
        backup.backend === 'gnome'
            ? [
                  ['httpHost', 'httpPort'],
                  ['httpsHost', 'httpsPort']
              ]
            : backup.backend === 'kde'
              ? [['httpProxy'], ['httpsProxy']]
              : [['server']]
    const owned = (key: string) =>
        current[key] === backup.applied[key] || current[key] === backup.previous[key]
    const next = { ...current }
    const restore = (key: string) => {
        if (backup.previous[key] !== backup.applied[key] && current[key] === backup.applied[key])
            next[key] = backup.previous[key]
    }
    // Restore endpoint pairs together, while preserving independently changed
    // endpoints, PAC URLs and bypass lists. Accept partial setup/restore writes.
    for (const group of groups) if (group.every(owned)) group.forEach(restore)
    if (backup.backend === 'gnome' && groups[0].every(owned)) restore('authentication')
    if (groups.every((group) => group.every(owned))) {
        const modes =
            backup.backend === 'gnome'
                ? ['mode', 'sameProxy']
                : backup.backend === 'kde'
                  ? ['ProxyType']
                  : ['flags']
        modes.forEach(restore)
    }
    if (keys.every((key) => current[key] === next[key])) return
    await adapter.write(next)
    const restored = await adapter.read()
    if (keys.some((key) => restored[key] !== next[key]))
        throw new Error('System proxy restoration could not be verified; backup retained')
}
