import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { basename, join, win32 } from 'node:path'
import { readFile, readdir, readlink } from 'node:fs/promises'
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
type LinuxConnection = { from: string; to: string; inode: string }
function procEndpoint(value: string) {
    const [hex, port] = value.split(':')
    const bytes = Buffer.from(hex, 'hex')
    let host: string
    if (bytes.length === 4) host = [...bytes.reverse()].join('.')
    else if (bytes.length === 16) {
        bytes.swap32()
        if (bytes.subarray(0, 10).every((v) => v === 0) && bytes.readUInt16BE(10) === 0xffff)
            host = [...bytes.subarray(12)].join('.')
        else {
            const groups = Array.from({ length: 8 }, (_, i) =>
                bytes.readUInt16BE(i * 2).toString(16)
            )
            host = new URL(`http://[${groups.join(':')}]/`).hostname
        }
    } else throw new Error('Invalid proc TCP address')
    return `${host}:${parseInt(port, 16)}`
}
export function parseLinuxConnections(output: string, port: number): LinuxConnection[] {
    return output.split('\n').flatMap((line) => {
        const fields = line.trim().split(/\s+/)
        if (fields.length < 10 || fields[3] !== '01' || !/^\d+$/.test(fields[9])) return []
        if (parseInt(fields[2].split(':')[1], 16) !== port) return []
        try {
            return [
                { from: procEndpoint(fields[1]), to: procEndpoint(fields[2]), inode: fields[9] }
            ]
        } catch {
            return []
        }
    })
}
async function linuxConnections(port: number, root: string): Promise<Connection[]> {
    const tables = await Promise.all(
        ['tcp', 'tcp6'].map((name) => readFile(join(root, 'net', name), 'utf8').catch(() => ''))
    )
    const connections = tables.flatMap((table) => parseLinuxConnections(table, port))
    if (!connections.length) return []
    const inodes = new Map(connections.map((row) => [`socket:[${row.inode}]`, row]))
    const result: Connection[] = []
    for (const pid of await readdir(root)) {
        if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue
        const directory = join(root, pid, 'fd')
        const fds = await readdir(directory).catch(() => [])
        const links = await Promise.all(
            fds.map((fd) => readlink(join(directory, fd)).catch(() => ''))
        )
        for (const link of new Set(links)) {
            const row = inodes.get(link)
            if (row) result.push({ pid: Number(pid), name: '', from: row.from, to: row.to })
        }
    }
    return result
}
export function parseWindowsConnections(output: string): Connection[] {
    return output.split('\n').flatMap((line) => {
        const match = /^\s*TCP\s+(\S+)\s+(\S+)\s+\S+\s+(\d+)\s*$/.exec(line)
        return match ? [{ pid: Number(match[3]), name: '', from: match[1], to: match[2] }] : []
    })
}
export type ClientIdentity = {
    client: string
    clientPID?: number
    clientIdentity?: string
    clientSource: 'process' | 'remote'
}
export class ProcessResolver {
    constructor(
        private platform: NodeJS.Platform = process.platform,
        private procRoot = '/proc'
    ) {}
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
        if (!['darwin', 'linux', 'win32'].includes(this.platform) || !socket.localPort)
            return undefined
        const port = socket.localPort
        let table = this.tables.get(port)
        if (!table) {
            table = (
                this.platform === 'linux'
                    ? linuxConnections(port, this.procRoot)
                    : this.platform === 'win32'
                      ? exec('netstat.exe', ['-ano'], {
                            timeout: 10000,
                            maxBuffer: 4 * 1024 * 1024
                        }).then((r) => parseWindowsConnections(r.stdout))
                      : exec('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-Fpcn'], {
                            timeout: 800,
                            maxBuffer: 4 * 1024 * 1024
                        }).then((r) => parseConnections(r.stdout))
            ).catch(() => [])
            this.tables.set(port, table)
            void table.finally(() => {
                if (this.tables.get(port) === table) this.tables.delete(port)
            })
        }
        const owner = connectionOwner(await table, socket)
        if (!owner) return undefined
        const executable =
            this.platform === 'linux'
                ? await readlink(join(this.procRoot, String(owner.pid), 'exe'))
                : this.platform === 'win32'
                  ? (
                        await exec(
                            'powershell.exe',
                            [
                                '-NoProfile',
                                '-NonInteractive',
                                '-Command',
                                `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); (Get-Process -Id ${owner.pid} -ErrorAction Stop).Path`
                            ],
                            // Allow for Windows PowerShell cold starts on busy machines.
                            {
                                timeout: 30000,
                                maxBuffer: 16384,
                                encoding: 'utf8',
                                windowsHide: true
                            }
                        )
                    ).stdout.trim()
                  : (
                        await exec('/bin/ps', ['-p', String(owner.pid), '-o', 'comm='], {
                            timeout: 300,
                            maxBuffer: 16384
                        })
                    ).stdout.trim()
        if (!executable) return undefined
        const appEnd = executable.indexOf('.app/')
        if (this.platform === 'darwin' && appEnd >= 0) {
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
            client:
                this.platform === 'win32'
                    ? win32.basename(executable, '.exe')
                    : basename(executable),
            clientPID: owner.pid,
            clientIdentity: `executable:${createHash('sha256').update(executable).digest('hex')}`,
            clientSource: 'process'
        }
    }
}
