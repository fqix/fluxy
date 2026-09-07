import type { Settings } from '../../shared/contracts/model'

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
    constructor(
        private settings: () => Settings,
        private engine: Engine,
        private tun: Tun,
        private systemProxy: SystemProxy
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

    start() {
        return this.enqueue(async () => {
            if (this.settings().captureMode === 'tun') {
                if (this.systemProxy.enabled) await this.systemProxy.set(false)
                await this.tun.start()
            } else if (this.settings().autoSystemProxy) {
                await this.enableSystemProxy()
            } else await this.engine.start()
        })
    }

    stop() {
        return this.enqueue(async () => {
            await this.tun.stop()
            if (this.systemProxy.enabled) await this.systemProxy.set(false)
            await this.engine.stop()
        })
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
