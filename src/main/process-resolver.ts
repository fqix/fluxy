import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { networkInterfaces } from 'node:os'
import type { Socket } from 'node:net'
const exec = promisify(execFile)
const address = (value: string) => value.replace(/^\[|\]$/g, '').replace(/^::ffff:/, '')
export type Connection = { pid: number; name: string; from: string; to: string }
export function parseConnections(output: string): Connection[] {
    let pid = 0,
        name = ''
    const result: Connection[] = []
    for (const line of output.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1))
        else if (line.startsWith('c')) name = line.slice(1)
        else if (line.startsWith('n') && line.includes('->')) {
            const [from, to] = line
                .slice(1)
                .replace(/ \(.*\)$/, '')
                .split('->')
            if (pid > 0) result.push({ pid, name, from, to })
        }
    }
    return result
}
function endpoint(value: string) {
    const split = value.lastIndexOf(':')
    return `${address(value.slice(0, split))}:${value.slice(split + 1)}`
}
export function connectionOwner(
    rows: Connection[],
    socket: Pick<Socket, 'remoteAddress' | 'remotePort' | 'localAddress' | 'localPort'>,
    excludePID = process.pid
) {
    const from = `${address(socket.remoteAddress ?? '')}:${socket.remotePort}`
    const to = `${address(socket.localAddress ?? '')}:${socket.localPort}`
    const owners = rows.filter(
        (r) => r.pid !== excludePID && endpoint(r.from) === from && endpoint(r.to) === to
    )
    return new Set(owners.map((r) => r.pid)).size === 1 ? owners[0] : undefined
}
export type ClientIdentity = {
    client: string
    clientPID?: number
    clientIdentity?: string
    clientSource: 'process' | 'remote'
}
export class ProcessResolver {
    private sockets = new WeakMap<Socket, Promise<ClientIdentity | undefined>>()
    private tables = new Map<number, Promise<Connection[]>>()
    resolve(socket: Socket): Promise<ClientIdentity | undefined> {
        const existing = this.sockets.get(socket)
        if (existing) return existing
        const task = this.lookup(socket).catch(() => undefined)
        this.sockets.set(socket, task)
        return task
    }
    private async lookup(socket: Socket): Promise<ClientIdentity | undefined> {
        const peer = address(socket.remoteAddress ?? '')
        const local =
            peer === '::1' ||
            peer.startsWith('127.') ||
            Object.values(networkInterfaces())
                .flat()
                .some((i) => i && address(i.address) === peer)
        if (!local) return peer ? { client: peer, clientSource: 'remote' } : undefined
        if (process.platform !== 'darwin' || !socket.localPort) return undefined
        const port = socket.localPort
        let table = this.tables.get(port)
        if (!table) {
            table = exec('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-Fpcn'], {
                timeout: 800,
                maxBuffer: 4 * 1024 * 1024
            })
                .then((r) => parseConnections(r.stdout))
                .catch(() => [])
            this.tables.set(port, table)
            void table.finally(() => {
                if (this.tables.get(port) === table) this.tables.delete(port)
            })
        }
        const owner = connectionOwner(await table, socket)
        if (!owner) return undefined
        const { stdout } = await exec('/bin/ps', ['-p', String(owner.pid), '-o', 'comm='], {
            timeout: 300,
            maxBuffer: 16384
        })
        const executable = stdout.trim()
        if (!executable) return undefined
        const appEnd = executable.indexOf('.app/')
        if (appEnd >= 0) {
            const app = executable.slice(0, appEnd + 4)
            try {
                const { stdout: info } = await exec(
                    '/usr/bin/plutil',
                    ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')],
                    { timeout: 300, maxBuffer: 1024 * 1024 }
                )
                const plist = JSON.parse(info)
                return {
                    client: String(
                        plist.CFBundleDisplayName || plist.CFBundleName || basename(app, '.app')
                    ),
                    clientPID: owner.pid,
                    clientIdentity: String(
                        plist.CFBundleIdentifier || createHash('sha256').update(app).digest('hex')
                    ),
                    clientSource: 'process'
                }
            } catch {
                /* Use the executable identity when a bundle cannot be read. */
            }
        }
        return {
            client: basename(executable),
            clientPID: owner.pid,
            clientIdentity: `executable:${createHash('sha256').update(executable).digest('hex')}`,
            clientSource: 'process'
        }
    }
}
