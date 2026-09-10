import { nativeWindowsQuery } from './native-windows'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Owned ingress PIDs also identify Windows snapshots that contain only a basename.
export const ownedProxyPids = new Set<number>()

export interface ProxyProcess {
    pid: number
    name: 'Mihomo' | 'sing-box'
}
export function parseProxyProcesses(output: string): ProxyProcess[] {
    return output.split('\n').flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/)
        if (!match || Number(match[1]) === process.pid || ownedProxyPids.has(Number(match[1])))
            return []
        const path = match[2].replaceAll('\\', '/').toLowerCase()
        if (
            path.endsWith('/fluxy.app/contents/resources/core/sing-box') ||
            path.endsWith('/fluxy-helper/sing-box') ||
            path.endsWith('/fluxy-helper/sing-box.exe') ||
            path.endsWith('/fluxyhelper/sing-box.exe') ||
            path.endsWith('/dev.fengqi.fluxy.electron.helper/sing-box')
        )
            return []
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
        return name ? [{ pid: Number(match[1]), name }] : []
    })
}
export async function discoverProxyProcesses(): Promise<ProxyProcess[]> {
    const execute = promisify(execFile)
    if (process.platform === 'win32') {
        const output = await nativeWindowsQuery('proxy-processes')
        if (typeof output !== 'string') throw new Error('Invalid Windows process snapshot')
        return parseProxyProcesses(output)
    }
    const { stdout } = await execute('ps', ['-axo', 'pid=,comm='], { timeout: 5000 })
    return parseProxyProcesses(stdout)
}
