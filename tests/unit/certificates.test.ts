import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, access, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { certificateStatus, ensureCertificate } from '../../src/main/certificates/certificates'

describe('setup certificate identity', () => {
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
})
