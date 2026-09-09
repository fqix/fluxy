import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../storage/store'
import {
    desktopProxyBackend,
    desktopProxyBackupSchema,
    restoreDesktopProxy,
    type DesktopProxyBackend
} from './desktop-proxy'
import { nativeWindowsHelperPath } from '../tun/native-windows'
const exec = promisify(execFile)
type ProxyState = {
    service: string
    kind: 'webproxy' | 'securewebproxy'
    enabled: boolean
    server: string
    port: string
}
export class SystemProxy {
    enabled = false
    private busy = false
    private watchdog?: ChildProcess
    private desktop?: DesktopProxyBackend
    private backupPath: string
    constructor(
        private store: Store,
        private platform: NodeJS.Platform = process.platform
    ) {
        this.backupPath = join(store.directory, 'system-proxy-backup.json')
    }
    private async command(args: string[]) {
        return (await exec('/usr/sbin/networksetup', args, { timeout: 15000 })).stdout
    }
    async recover() {
        if (existsSync(this.backupPath)) {
            this.enabled = true
            await this.set(false)
        }
    }
    async set(enabled: boolean) {
        if (this.busy) throw new Error('System proxy configuration is already in progress')
        this.busy = true
        try {
            if (this.platform !== 'darwin') {
                await this.setDesktop(enabled)
                return
            }
            if (enabled) {
                if (this.enabled) return
                if (existsSync(this.backupPath))
                    throw new Error('Restore the previous proxy backup before enabling capture')
                const services = (await this.command(['-listallnetworkservices']))
                    .trim()
                    .split('\n')
                    .slice(1)
                    .filter((s) => s && !s.startsWith('*'))
                const backup: ProxyState[] = []
                for (const service of services)
                    for (const kind of ['webproxy', 'securewebproxy'] as const) {
                        const raw = await this.command([`-get${kind}`, service])
                        const fields = Object.fromEntries(
                            raw
                                .trim()
                                .split('\n')
                                .map((line) => {
                                    const at = line.indexOf(':')
                                    return [line.slice(0, at), line.slice(at + 1).trim()]
                                })
                        )
                        if (fields['Authenticated Proxy Enabled'] === '1')
                            throw new Error(
                                `The ${service} service uses an authenticated proxy. Configure Fluxy manually to preserve those credentials.`
                            )
                        backup.push({
                            service,
                            kind,
                            enabled: fields.Enabled === 'Yes',
                            server: fields.Server,
                            port: fields.Port
                        })
                    }
                this.store.write('system-proxy-backup.json', {
                    port: this.store.settings.port,
                    entries: backup
                })
                // Also track partially applied settings if rollback fails, so Stop
                // and quit retry restoration while the listener is still available.
                this.enabled = true
                try {
                    for (const item of backup) {
                        await this.command([
                            `-set${item.kind}`,
                            item.service,
                            '127.0.0.1',
                            String(this.store.settings.port)
                        ])
                        await this.command([`-set${item.kind}state`, item.service, 'on'])
                    }
                    this.enabled = true
                    await this.startWatchdog()
                } catch (error) {
                    await this.restore()
                    throw error
                }
            } else await this.restore()
        } finally {
            this.busy = false
        }
    }
    private async startWatchdog() {
        this.watchdog = spawn(
            process.execPath,
            [
                join(__dirname, 'watchdog.js'),
                this.store.directory,
                String(process.pid),
                this.platform === 'win32' ? await nativeWindowsHelperPath() : ''
            ],
            {
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                detached: true,
                windowsHide: true,
                stdio: 'ignore'
            }
        )
        this.watchdog.on('error', () => {
            /* Startup recovery retains the on-disk backup. */
        })
        this.watchdog.unref()
    }
    private async setDesktop(enabled: boolean) {
        if (!enabled) return this.restore()
        if (this.enabled) return
        if (existsSync(this.backupPath))
            throw new Error('Restore the previous proxy backup before enabling capture')
        this.desktop = await desktopProxyBackend(this.platform)
        const previous = await this.desktop.read()
        const applied = this.desktop.target(previous, this.store.settings.port)
        this.store.write('system-proxy-backup.json', {
            version: 1,
            backend: this.desktop.id,
            previous,
            applied
        })
        this.enabled = true
        try {
            await this.desktop.write(applied)
            const current = await this.desktop.read()
            if (Object.keys(applied).some((key) => current[key] !== applied[key]))
                throw new Error('System proxy setup could not be verified')
            await this.startWatchdog()
        } catch (error) {
            await this.restore()
            throw error
        }
    }
    private async restore() {
        if (!existsSync(this.backupPath)) {
            this.enabled = false
            return
        }
        const saved = JSON.parse(readFileSync(this.backupPath, 'utf8'))
        if (saved.backend) {
            const backup = desktopProxyBackupSchema.parse(saved)
            this.desktop ??= await desktopProxyBackend(
                this.platform,
                process.env,
                undefined,
                backup.backend
            )
            await restoreDesktopProxy(backup, this.desktop)
            unlinkSync(this.backupPath)
            this.enabled = false
            this.watchdog?.kill()
            this.watchdog = undefined
            return
        }
        if (this.platform !== 'darwin')
            throw new Error('Proxy backup belongs to a different platform')
        const { port, entries: backup }: { port: number; entries: ProxyState[] } = saved
        for (const item of backup) {
            const current = await this.command([`-get${item.kind}`, item.service])
            // Preserve proxy changes made by another application after Fluxy took ownership.
            if (!current.includes('Server: 127.0.0.1\n') || !current.includes(`Port: ${port}\n`))
                continue
            if (item.server && Number(item.port) > 0)
                await this.command([`-set${item.kind}`, item.service, item.server, item.port])
            await this.command([`-set${item.kind}state`, item.service, item.enabled ? 'on' : 'off'])
        }
        unlinkSync(this.backupPath)
        this.enabled = false
        this.watchdog?.kill()
        this.watchdog = undefined
    }
}
