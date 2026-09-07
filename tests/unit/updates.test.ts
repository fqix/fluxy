import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { UpdateService } from '../../src/main/updates/updates'
function fixture(supported = true) {
    const backend = Object.assign(new EventEmitter(), {
        autoDownload: true,
        autoInstallOnAppQuit: true,
        allowDowngrade: true,
        allowPrerelease: true,
        checkForUpdates: vi.fn(async () => {
            backend.emit('update-available', { version: '2.0.0', releaseNotes: 'Changes' })
            return {}
        }),
        downloadUpdate: vi.fn(async (_token?: unknown) => {
            backend.emit('download-progress', { percent: 50, transferred: 50, total: 100 })
            backend.emit('update-downloaded', { version: '2.0.0' })
            return ['update.zip']
        }),
        quitAndInstall: vi.fn()
    })
    const changed = vi.fn(),
        recover = vi.fn(),
        service = new UpdateService(backend as never, '1.0.0', supported, changed, recover)
    return { backend, service, changed, recover }
}
describe('automatic update lifecycle', () => {
    it('checks, verifies download and cleans up before installing', async () => {
        const { backend, service } = fixture(),
            order: string[] = []
        expect(backend.autoDownload).toBe(false)
        expect(backend.autoInstallOnAppQuit).toBe(false)
        expect(backend.allowDowngrade).toBe(false)
        await service.check()
        expect(service.state.phase).toBe('available')
        await service.download()
        expect(service.state.phase).toBe('downloaded')
        backend.quitAndInstall.mockImplementation(() => {
            order.push('install')
        })
        await service.install(async () => {
            order.push('cleanup')
        })
        expect(order).toEqual(['cleanup', 'install'])
        service.close()
    })
    it('keeps development builds inert and supports automatic download preference', async () => {
        const dev = fixture(false)
        await dev.service.check(true)
        expect(dev.backend.checkForUpdates).not.toHaveBeenCalled()
        dev.service.close()
        const ready = fixture()
        await ready.service.check(true)
        expect(ready.service.state.phase).toBe('downloaded')
        ready.service.close()
    })
    it('deduplicates checks and reports failures so the user can retry', async () => {
        const { backend, service } = fixture()
        let resolve!: () => void
        backend.checkForUpdates.mockImplementation(
            () =>
                new Promise<void>((r) => {
                    resolve = r
                }) as never
        )
        const first = service.check(),
            second = service.check()
        expect(backend.checkForUpdates).toHaveBeenCalledTimes(1)
        backend.emit('update-not-available')
        resolve()
        await Promise.all([first, second])
        expect(service.state.phase).toBe('current')
        backend.checkForUpdates.mockRejectedValueOnce(new Error('offline'))
        await service.check()
        expect(service.state.error).toContain('offline')
        service.close()
    })
    it('cancels a download and never installs on failed cleanup', async () => {
        const { backend, service } = fixture()
        await service.check()
        backend.downloadUpdate.mockImplementation(
            (token: any) =>
                new Promise((_resolve, reject) =>
                    token.onCancel(() => reject(new Error('cancelled')))
                )
        )
        const pending = service.download()
        service.cancel()
        await pending
        expect(service.state.phase).toBe('available')
        backend.emit('update-downloaded', { version: '2.0.0' })
        await expect(
            service.install(async () => {
                throw new Error('routes still active')
            })
        ).rejects.toThrow('routes still active')
        expect(backend.quitAndInstall).not.toHaveBeenCalled()
        expect(service.state.phase).toBe('downloaded')
        service.close()
    })
    it('recovers the app when native installation fails asynchronously', async () => {
        const { backend, service, recover } = fixture()
        await service.check()
        await service.download()
        await service.install(async () => {})
        backend.emit('error', new Error('Signature rejected'))
        expect(recover).toHaveBeenCalledOnce()
        expect(service.state.phase).toBe('error')
        service.close()
        expect(() => backend.emit('error', new Error('late cancellation'))).not.toThrow()
    })
})
