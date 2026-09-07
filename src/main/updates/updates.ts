import type { AppUpdater } from 'electron-updater'
import { CancellationToken } from 'builder-util-runtime'
import type { UpdateState } from '../../shared/app/updates'
type EventName = Parameters<AppUpdater['removeListener']>[0]
type Backend = Pick<
    AppUpdater,
    | 'on'
    | 'removeListener'
    | 'checkForUpdates'
    | 'downloadUpdate'
    | 'quitAndInstall'
    | 'autoDownload'
    | 'autoInstallOnAppQuit'
    | 'allowDowngrade'
    | 'allowPrerelease'
>
export class UpdateService {
    state: UpdateState
    private operation?: Promise<unknown>
    private cancellation?: CancellationToken
    private timers: ReturnType<typeof setTimeout>[] = []
    private listeners: { name: EventName; handler: (value: any) => void }[] = []
    private closed = false
    constructor(
        private backend: Backend,
        version: string,
        private supported: boolean,
        private changed: () => void,
        private installationFailed: () => void = () => {}
    ) {
        this.state = {
            phase: supported ? 'idle' : 'unsupported',
            currentVersion: version,
            ...(!supported
                ? {
                      error: 'Automatic installation requires a packaged application. Development builds can be updated from source.'
                  }
                : {})
        }
        backend.autoDownload = false
        backend.autoInstallOnAppQuit = false
        backend.allowDowngrade = false
        backend.allowPrerelease = false
        const listen = (name: EventName, handler: (value: any) => void) => {
            this.listeners.push({ name, handler })
            backend.on(name, handler)
        }
        listen('checking-for-update', () => this.set({ phase: 'checking', error: undefined }))
        listen('update-available', (info) =>
            this.set({
                phase: 'available',
                version: info.version,
                notes:
                    typeof info.releaseNotes === 'string'
                        ? info.releaseNotes
                        : Array.isArray(info.releaseNotes)
                          ? info.releaseNotes.map((n: any) => n.note).join('\n')
                          : '',
                checkedAt: Date.now()
            })
        )
        listen('update-not-available', () =>
            this.set({
                phase: 'current',
                version: undefined,
                notes: undefined,
                checkedAt: Date.now()
            })
        )
        listen('download-progress', (progress) =>
            this.set({
                phase: 'downloading',
                percent: Math.min(100, Math.max(0, progress.percent)),
                transferred: progress.transferred,
                total: progress.total
            })
        )
        listen('update-downloaded', (info) =>
            this.set({ phase: 'downloaded', version: info.version, percent: 100, error: undefined })
        )
        listen('error', (error) => {
            if (this.closed) return
            if (this.state.phase === 'installing') this.installationFailed()
            if (!this.cancellation?.cancelled)
                this.set({ phase: 'error', error: String(error.message ?? error) })
        })
    }
    private set(patch: Partial<UpdateState>) {
        if (!this.closed) {
            this.state = { ...this.state, ...patch }
            this.changed()
        }
    }
    async check(autoDownload = false) {
        if (!this.supported || this.closed) return this.state
        if (this.operation) return this.operation
        if (['downloaded', 'installing'].includes(this.state.phase)) return this.state
        this.set({ phase: 'checking', error: undefined, percent: undefined })
        this.operation = this.backend
            .checkForUpdates()
            .catch((error) => this.set({ phase: 'error', error: String(error.message ?? error) }))
            .finally(() => {
                this.operation = undefined
            })
        await this.operation
        if (autoDownload && this.state.phase === 'available') await this.download()
        return this.state
    }
    async download() {
        if (this.operation) return this.operation
        if (
            !this.supported ||
            this.closed ||
            !this.state.version ||
            !['available', 'error'].includes(this.state.phase)
        )
            throw new Error('Check for an available update first')
        this.cancellation = new CancellationToken()
        const token = this.cancellation
        this.set({ phase: 'downloading', percent: 0, error: undefined })
        this.operation = this.backend
            .downloadUpdate(token)
            .catch((error) => {
                if (token.cancelled)
                    this.set({ phase: 'available', percent: undefined, error: undefined })
                else this.set({ phase: 'error', error: String(error.message ?? error) })
            })
            .finally(() => {
                this.operation = undefined
                this.cancellation = undefined
            })
        await this.operation
        return this.state
    }
    cancel() {
        if (this.state.phase === 'downloading') this.cancellation?.cancel()
    }
    async install(cleanup: () => Promise<void>) {
        if (this.state.phase !== 'downloaded')
            throw new Error('Download and verify an update before installing')
        this.set({ phase: 'installing' })
        try {
            await cleanup()
            this.backend.quitAndInstall(false, true)
        } catch (error) {
            this.set({ phase: 'downloaded', error: String(error) })
            throw error
        }
    }
    schedule(preferences: () => { checkAutomatically: boolean; downloadAutomatically: boolean }) {
        if (!this.supported) return
        const tick = () => {
            const p = preferences()
            if (p.checkAutomatically) void this.check(p.downloadAutomatically)
        }
        this.timers.push(setTimeout(tick, 10000), setInterval(tick, 4 * 60 * 60 * 1000))
        this.timers.forEach((t) => t.unref())
    }
    close() {
        this.closed = true
        this.cancellation?.cancel()
        this.timers.forEach(clearTimeout)
        for (const { name, handler } of this.listeners)
            if (name !== 'error') this.backend.removeListener(name, handler)
    }
}
