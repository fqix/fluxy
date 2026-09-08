import { requiredCaptureDomainsSchema, type Settings } from '../../shared/contracts/model'

interface Engine {
    running: boolean
    start(): Promise<void>
    stop(): Promise<void>
}
interface Tun {
    status: { state: string }
    start(): Promise<void>
    stop(): Promise<void>
}
interface SystemProxy {
    enabled: boolean
    set(enabled: boolean): Promise<void>
}

// Serialize capture changes so Stop/quit cannot overtake a pending proxy setup.
export class CaptureController {
    private pending: Promise<void> = Promise.resolve()
    private operations = 0
    private startGeneration = 0
    private preparing?: AbortController
    constructor(
        private settings: () => Settings,
        private engine: Engine,
        private tun: Tun,
        private systemProxy: SystemProxy,
        private beforeTunStart?: (signal: AbortSignal, automatic: boolean) => Promise<boolean>
    ) {}

    private enqueue(action: () => Promise<void>) {
        this.operations++
        const result = this.pending.then(action).finally(() => {
            this.operations--
        })
        this.pending = result.catch(() => {})
        return result
    }

    settled() {
        return this.pending
    }

    get busy() {
        return this.operations > 0
    }

    restore() {
        return this.settings().autoStart ? this.start(true) : Promise.resolve()
    }

    start(automatic = false) {
        const generation = this.startGeneration
        return this.enqueue(async () => {
            if (this.settings().captureMode === 'tun') {
                if (generation !== this.startGeneration) return
                if (this.tun.status.state === 'running') return
                const domains = requiredCaptureDomainsSchema.safeParse(
                    this.settings().tun.captureDomains
                )
                if (!domains.success) throw new Error(domains.error.issues[0].message)
                if (this.beforeTunStart) {
                    const controller = new AbortController()
                    this.preparing = controller
                    try {
                        if (
                            !(await this.beforeTunStart(controller.signal, automatic)) ||
                            controller.signal.aborted
                        )
                            return
                    } finally {
                        this.preparing = undefined
                    }
                }
                if (this.systemProxy.enabled) await this.systemProxy.set(false)
                await this.tun.start()
            } else if (this.settings().autoSystemProxy) {
                await this.enableSystemProxy()
            } else await this.engine.start()
        })
    }

    stop() {
        this.cancelPendingStart()
        return this.enqueue(async () => {
            await this.tun.stop()
            if (this.systemProxy.enabled) await this.systemProxy.set(false)
            await this.engine.stop()
        })
    }

    cancelPendingStart() {
        this.startGeneration++
        this.preparing?.abort()
    }

    setSystemProxy(enabled: boolean) {
        return this.enqueue(async () => {
            if (
                enabled &&
                (this.settings().captureMode === 'tun' ||
                    ['starting', 'running', 'stopping'].includes(this.tun.status.state))
            )
                throw new Error('Stop TUN and select HTTP Proxy mode before enabling System Proxy')
            if (enabled) await this.enableSystemProxy()
            else await this.systemProxy.set(false)
        })
    }

    private async enableSystemProxy() {
        const wasRunning = this.engine.running
        await this.engine.start()
        try {
            await this.systemProxy.set(true)
        } catch (error) {
            // Keep the listener available if proxy restoration itself failed.
            if (!wasRunning && !this.systemProxy.enabled) await this.engine.stop()
            throw error
        }
    }
}
