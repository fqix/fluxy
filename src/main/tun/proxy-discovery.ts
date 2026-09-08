import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export interface ProxyProcess {
    pid: number
    name: 'Mihomo' | 'sing-box'
}
export function parseProxyProcesses(output: string): ProxyProcess[] {
    return output.split('\n').flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/)
        if (!match || Number(match[1]) === process.pid) return []
        const executable = match[2]
            .split(/[\\/]/)
            .pop()
            ?.replace(/\.exe$/i, '')
            .toLowerCase()
        const name = ['mihomo', 'verge-mihomo', 'clash-meta'].includes(executable ?? '')
            ? 'Mihomo'
            : ['sing-box', 'singbox'].includes(executable ?? '')
              ? 'sing-box'
              : undefined
        // Fluxy's embedded sing-box is fluxy-core, not one of these executable names.
        return name ? [{ pid: Number(match[1]), name }] : []
    })
}
export async function discoverProxyProcesses(): Promise<ProxyProcess[]> {
    const execute = promisify(execFile)
    if (process.platform === 'win32') {
        const { stdout } = await execute(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                "Get-Process | ForEach-Object { '{0} {1}' -f $_.Id,$_.ProcessName }"
            ],
            { timeout: 5000, windowsHide: true }
        )
        return parseProxyProcesses(stdout)
    }
    const { stdout } = await execute('ps', ['-axo', 'pid=,comm='], { timeout: 5000 })
    return parseProxyProcesses(stdout)
}
