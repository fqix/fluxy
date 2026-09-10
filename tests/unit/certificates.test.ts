import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { mkdtemp, rm, access, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import {
    certificateStatus,
    ensureCertificate,
    requireTunCertificate
} from '../../src/main/certificates/certificates'
import { nativeWindowsQuery } from '../../src/main/tun/native-windows'

vi.mock('../../src/main/tun/native-windows', () => ({ nativeWindowsQuery: vi.fn() }))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
    vi.mocked(nativeWindowsQuery).mockReset().mockResolvedValue(false)
})
afterEach(() => Object.defineProperty(process, 'platform', platform))

describe('setup certificate identity', () => {
    it('checks live trust before TUN startup without generating or installing a CA', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' })
        const directory = await mkdtemp(join(tmpdir(), 'fluxy-tun-ca-'))
        try {
            await expect(requireTunCertificate(directory)).rejects.toThrow('install and trust')
            await expect(access(join(directory, 'certs/ca.pem'))).rejects.toThrow()
            const path = await ensureCertificate(directory)
            await expect(requireTunCertificate(directory)).rejects.toThrow('install and trust')
            vi.mocked(nativeWindowsQuery).mockResolvedValue(true)
            await expect(requireTunCertificate(directory)).resolves.toBeUndefined()
            vi.mocked(nativeWindowsQuery).mockResolvedValue(false)
            await expect(requireTunCertificate(directory)).rejects.toThrow('install and trust')
            await expect(requireTunCertificate(directory, path)).rejects.toThrow(
                'active custom root'
            )
            vi.mocked(nativeWindowsQuery).mockResolvedValue(true)
            await expect(requireTunCertificate(directory, path)).resolves.toBeUndefined()
            vi.mocked(nativeWindowsQuery).mockRejectedValue(new Error('query failed'))
            await expect(requireTunCertificate(directory)).rejects.toThrow(
                'trust could not be checked'
            )
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    })
    it('checks fresh setup without generating a certificate or key', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'fluxy-status-'))
        try {
            expect(await certificateStatus(directory)).toEqual({
                generated: false,
                trusted: false,
                supported: ['darwin', 'linux', 'win32'].includes(process.platform)
            })
            await expect(access(join(directory, 'keys'))).rejects.toThrow()
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    })
    it('concurrent setup and capture reuse one identity and never infer trust from its existence', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'fluxy-identity-'))
        try {
            const [a, b] = await Promise.all([
                ensureCertificate(directory),
                ensureCertificate(directory)
            ])
            expect(a).toBe(b)
            const before = await readFile(a, 'utf8')
            await ensureCertificate(directory)
            expect(await readFile(a, 'utf8')).toBe(before)
            expect(await certificateStatus(directory)).toEqual({
                generated: true,
                trusted: false,
                supported: ['darwin', 'linux', 'win32'].includes(process.platform)
            })
            await unlink(a)
            expect(await certificateStatus(directory)).toMatchObject({
                generated: false,
                trusted: false,
                error: expect.stringContaining('key exists')
            })
            await expect(ensureCertificate(directory)).rejects.toThrow('key exists')
            await expect(access(a)).rejects.toThrow()
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    })

    it.each([true, false])('reports native Windows trust as %s', async (trusted) => {
        Object.defineProperty(process, 'platform', { value: 'win32' })
        vi.mocked(nativeWindowsQuery).mockResolvedValue(trusted)
        const directory = await mkdtemp(join(tmpdir(), 'fluxy-windows-trust-'))
        try {
            const path = await ensureCertificate(directory)
            expect(await certificateStatus(directory)).toEqual({
                generated: true,
                trusted,
                supported: true
            })
            expect(nativeWindowsQuery).toHaveBeenCalledExactlyOnceWith('certificate-status', {
                der: new X509Certificate(await readFile(path)).raw.toString('base64')
            })
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    })

    it('reports a failed Windows trust query without treating it as an untrusted result', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' })
        vi.mocked(nativeWindowsQuery).mockRejectedValue(new Error('Helper unavailable'))
        const directory = await mkdtemp(join(tmpdir(), 'fluxy-windows-trust-error-'))
        try {
            await ensureCertificate(directory)
            expect(await certificateStatus(directory)).toMatchObject({
                generated: true,
                trusted: false,
                error: expect.stringContaining('could not be checked')
            })
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    })
})
