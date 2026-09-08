import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { X509Certificate } from 'node:crypto'
import { CertificateTrust } from '../../src/main/certificates/certificate-trust'
import { BrowserTrust } from '../../src/main/certificates/browser-trust'
import { ensureCertificate } from '../../src/main/certificates/certificates'

let fixtures: string, pem: Buffer
beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), 'fluxy-trust-fixtures-'))
    pem = await readFile(await ensureCertificate(fixtures))
})
afterAll(() => rm(fixtures, { recursive: true, force: true }))
describe('certificate trust lifecycle', () => {
    let directory: string
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'fluxy-trust-'))
        await mkdir(join(directory, 'certificates/certs'), { recursive: true })
        await writeFile(join(directory, 'certificates/certs/ca.pem'), pem)
    })
    afterEach(() => rm(directory, { recursive: true, force: true }))
    function service(remove = vi.fn(async (_der: Buffer) => {})) {
        const browsers = new BrowserTrust(directory, 'linux')
        const update = vi.spyOn(browsers, 'update').mockResolvedValue(undefined)
        const status = vi.fn(async () => ({ generated: true, trusted: true, supported: true }))
        return {
            trust: new CertificateTrust(directory, remove, browsers, status),
            update,
            status,
            remove
        }
    }
    it('only fills browser trust for an already trusted root and never creates one at startup', async () => {
        const { trust, status, update } = service()
        status.mockResolvedValueOnce({ generated: true, trusted: false, supported: true })
        await trust.sync()
        expect(update).not.toHaveBeenCalled()
        await trust.sync()
        expect(update).toHaveBeenCalledWith(expect.any(X509Certificate), true)
    })
    it('revokes the exact system CA then browser trust, persists opt-out, and resumes only after explicit setup', async () => {
        const { trust, remove, update } = service()
        await trust.remove()
        expect(remove).toHaveBeenCalledWith(new X509Certificate(pem).raw)
        expect(update).toHaveBeenCalledWith(expect.any(X509Certificate), false)
        const restarted = service()
        await restarted.trust.sync()
        expect(restarted.update).not.toHaveBeenCalled()
        await restarted.trust.sync(true)
        expect(restarted.update).toHaveBeenCalledWith(expect.any(X509Certificate), true)
        await expect(access(join(directory, 'browser-ca-disabled'))).rejects.toThrow()
    })
    it('does not resurrect trust after failed removal and allows cleanup to be retried', async () => {
        const failure = vi
            .fn()
            .mockRejectedValueOnce(new Error('Removal failed'))
            .mockResolvedValue(undefined)
        const { trust, update } = service(failure)
        await expect(trust.remove()).rejects.toThrow('Removal failed')
        await trust.sync()
        expect(update).not.toHaveBeenCalled()
        await trust.remove()
        expect(update).toHaveBeenCalledWith(expect.any(X509Certificate), false)
    })
    it('exposes browser setup failure until a successful retry', async () => {
        const { trust, update } = service()
        update.mockRejectedValueOnce(new Error('Firefox database locked'))
        await expect(trust.sync()).rejects.toThrow('Firefox database locked')
        expect(trust.browserError).toBe('Firefox database locked')
        await trust.sync(true)
        expect(trust.browserError).toBeUndefined()
    })
    it('serializes in-flight startup and removal; shutdown waits for both', async () => {
        const { trust, update } = service()
        let finish!: () => void
        update.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve
                })
        )
        const start = trust.exclusive(() => trust.sync())
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
        const remove = trust.exclusive(() => trust.remove())
        let settled = false
        void trust.settled().then(() => {
            settled = true
        })
        await Promise.resolve()
        expect(settled).toBe(false)
        finish()
        await Promise.all([start, remove])
        expect(update.mock.calls.map((call) => call[1])).toEqual([true, false])
        await trust.exclusive(() => trust.sync())
        expect(update).toHaveBeenCalledTimes(2)
    })
    it('can remove an expired identity without asking certificateStatus to validate its key', async () => {
        const { trust, status, remove } = service()
        await trust.remove()
        expect(status).not.toHaveBeenCalled()
        expect(remove).toHaveBeenCalledOnce()
    })
})
