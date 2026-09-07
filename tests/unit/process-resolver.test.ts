import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Socket } from 'node:net'
import {
    connectionOwner,
    parseLinuxConnections,
    parseWindowsConnections,
    ProcessResolver
} from '../../src/main/capture/process-resolver'

const socket = {
    remoteAddress: '127.0.0.1',
    remotePort: 50000,
    localAddress: '127.0.0.1',
    localPort: 9090
} as Socket
const procRow = (from: string, to: string, inode = '1234', state = '01') =>
    `0: ${from} ${to} ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode}`
const directories: string[] = []
afterEach(async () => {
    await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('cross-platform process attribution', () => {
    it('reads Linux IPv4 and IPv4-mapped IPv6 client sockets', () => {
        const ipv4 = procRow('0100007F:C350', '0100007F:2382')
        const mapped = procRow(
            '0000000000000000FFFF00000100007F:C350',
            '0000000000000000FFFF00000100007F:2382'
        )
        for (const table of [ipv4, mapped])
            expect(parseLinuxConnections(table, 9090)).toEqual([
                { from: '127.0.0.1:50000', to: '127.0.0.1:9090', inode: '1234' }
            ])
        expect(parseLinuxConnections(ipv4, 8080)).toEqual([])
        expect(
            parseLinuxConnections(procRow('0100007F:C350', '0100007F:2382', '1234', '06'), 9090)
        ).toEqual([])
    })
    it('normalizes Linux IPv6 endpoints for exact ownership matching', () => {
        const [row] = parseLinuxConnections(
            procRow(
                '00000000000000000000000001000000:C350',
                '00000000000000000000000001000000:2382'
            ),
            9090
        )
        expect(
            connectionOwner(
                [{ ...row, pid: 22, name: '' }],
                { ...socket, remoteAddress: '::1', localAddress: '::1' },
                11
            )?.pid
        ).toBe(22)
    })
    it('matches Windows client endpoints and rejects reversed or ambiguous owners', () => {
        const rows = parseWindowsConnections(`
Active Connections
  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:9090          127.0.0.1:50000        ESTABLISHED     11
  TCP    127.0.0.1:50000         127.0.0.1:9090         ESTABLISHED     22
  TCP    [::1]:50000            [::1]:9090             ESTABLISHED     33
  UDP    127.0.0.1:50000         *:*                                    44
`)
        expect(connectionOwner(rows, socket, 11)?.pid).toBe(22)
        expect(
            connectionOwner(rows, { ...socket, remoteAddress: '::1', localAddress: '::1' }, 11)?.pid
        ).toBe(33)
        expect(connectionOwner([...rows, { ...rows[1], pid: 55 }], socket, 11)).toBeUndefined()
    })
    it.skipIf(process.platform === 'win32')(
        'resolves a Linux socket inode to its executable without exposing its path',
        async () => {
            const directory = await mkdtemp(join(tmpdir(), 'fluxy-proc-'))
            directories.push(directory)
            const pid = process.pid + 10000
            await mkdir(join(directory, 'net'))
            await mkdir(join(directory, String(pid), 'fd'), { recursive: true })
            await writeFile(
                join(directory, 'net', 'tcp'),
                procRow('0100007F:C350', '0100007F:2382')
            )
            await symlink('socket:[1234]', join(directory, String(pid), 'fd', '4'))
            await symlink('/usr/bin/curl', join(directory, String(pid), 'exe'))
            const resolver = new ProcessResolver('linux', directory)
            expect(await resolver.resolve({ ...socket } as Socket)).toMatchObject({
                client: 'curl',
                clientPID: pid,
                clientSource: 'process'
            })
            expect((await resolver.resolve({ ...socket } as Socket))?.clientIdentity).toMatch(
                /^executable:[a-f0-9]{64}$/
            )
            await rm(join(directory, String(pid)), { recursive: true })
            expect(await resolver.resolve({ ...socket } as Socket)).toBeUndefined()
        }
    )
    it('leaves inaccessible Linux process tables unresolved and identifies remote clients separately', async () => {
        const resolver = new ProcessResolver('linux', join(tmpdir(), 'fluxy-proc-does-not-exist'))
        expect(await resolver.resolve({ ...socket } as Socket)).toBeUndefined()
        expect(
            await resolver.resolve({ ...socket, remoteAddress: '203.0.113.20' } as Socket)
        ).toEqual({ client: '203.0.113.20', clientSource: 'remote' })
    })
})
