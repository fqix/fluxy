// Independent process: restore only the proxy settings still owned by Fluxy
// when the Electron main process exits without completing normal cleanup.
import { existsSync, readFileSync, unlinkSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { desktopProxyBackupSchema, restoreDesktopProxy } from './desktop-proxy'
const [directory, parentPID] = process.argv.slice(2)
const parent = Number(parentPID)
if (!directory || !Number.isInteger(parent) || parent < 1) process.exit(1)
const backup = join(directory, 'system-proxy-backup.json')
const timer = setInterval(async () => {
    try {
        process.kill(parent, 0)
        return
    } catch {
        clearInterval(timer)
    }
    if (!existsSync(backup)) process.exit(0)
    try {
        const saved = JSON.parse(readFileSync(backup, 'utf8'))
        if (saved.backend) {
            await restoreDesktopProxy(desktopProxyBackupSchema.parse(saved))
            unlinkSync(backup)
            process.exit(0)
        }
        if (process.platform !== 'darwin')
            throw new Error('Proxy backup belongs to a different platform')
        const { port, entries } = saved
        const command = (args: string[]) =>
            execFileSync('/usr/sbin/networksetup', args, { timeout: 15000, encoding: 'utf8' })
        for (const item of entries) {
            const current = command([`-get${item.kind}`, item.service])
            if (!current.includes('Server: 127.0.0.1\n') || !current.includes(`Port: ${port}\n`))
                continue
            if (item.server && Number(item.port) > 0)
                command([`-set${item.kind}`, item.service, item.server, item.port])
            command([`-set${item.kind}state`, item.service, item.enabled ? 'on' : 'off'])
        }
        unlinkSync(backup)
    } catch (error) {
        appendFileSync(
            join(directory, 'recovery.log'),
            `${new Date().toISOString()} ${String(error)}\n`,
            { mode: 0o600 }
        )
    }
    process.exit(0)
}, 1000)
