import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelperService } from '../../src/main/system/helper'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => Object.defineProperty(process, 'platform', platform))

it.each(['install', 'remove'] as const)(
    'can %s Windows certificate trust without a service, pairing token or core',
    async (action) => {
        Object.defineProperty(process, 'platform', { value: 'win32' })
        const directory = await mkdtemp(join(tmpdir(), 'fluxy-ca-helper-'))
        const helperPath = join(directory, 'fluxy-helper.exe')
        const source = 'bundled helper fixture'
        await writeFile(helperPath, source)
        await writeFile(
            helperPath + '.json',
            JSON.stringify({
                version: 1,
                buildID: 'a'.repeat(64),
                helperSHA256: createHash('sha256').update(source).digest('hex'),
                coreSHA256: 'b'.repeat(64)
            })
        )
        const authorize = vi.fn().mockResolvedValue(undefined)
        const helper = new HelperService(
            directory,
            helperPath,
            join(directory, 'missing-core'),
            () => {},
            join(directory, 'missing-pipe'),
            authorize
        )
        const certificate = Buffer.from('public DER fixture')
        const invoke = () =>
            action === 'install'
                ? helper.installCertificate(certificate)
                : helper.removeCertificate(certificate)
        try {
            await invoke()
            expect(authorize).toHaveBeenCalledExactlyOnceWith(
                JSON.stringify({
                    action: `${action}-certificate`,
                    certificate: certificate.toString('base64')
                })
            )
            expect(helper.status.state).toBe('missing')
            authorize.mockRejectedValueOnce(new Error('Windows authorization canceled'))
            await expect(invoke()).rejects.toThrow('Windows authorization canceled')
            await invoke() // Cancellation releases the operation lock.
            await writeFile(helperPath, 'tampered')
            await expect(invoke()).rejects.toThrow()
            expect(authorize).toHaveBeenCalledTimes(3)
        } finally {
            helper.close()
            await rm(directory, { recursive: true, force: true })
        }
    }
)
