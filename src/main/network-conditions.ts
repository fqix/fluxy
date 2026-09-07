import { Transform } from 'node:stream'
import { performance } from 'node:perf_hooks'
import type { Duplex } from 'node:stream'
import type { Rule, Headers } from '../shared/model'
import { networkPresets } from '../shared/network-conditions'
import { matchesBreakpoint } from './rule-match'
export function activeNetworkCondition(
    rules: Rule[],
    method: string,
    url: string,
    headers: Headers
) {
    const active = rules.find((r) => r.enabled && r.kind === 'networkCondition')
    return active &&
        matchesBreakpoint(
            active,
            method,
            url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'),
            headers
        )
        ? active
        : undefined
}
export function networkRates(rule?: Rule) {
    if (!rule) return { delay: 0, uploadKbps: 0, downloadKbps: 0 }
    const preset = networkPresets[rule.networkPreset ?? 'custom']
    return {
        delay: rule.delay,
        uploadKbps:
            (rule.networkPreset ?? 'custom') === 'custom' ? rule.uploadKbps : preset.uploadKbps,
        downloadKbps:
            (rule.networkPreset ?? 'custom') === 'custom' ? rule.downloadKbps : preset.downloadKbps
    }
}
export function waitNetwork(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
            reject(new Error('Connection closed'))
            return
        }
        const abort = () => {
            clearTimeout(timer)
            signal.removeEventListener('abort', abort)
            reject(new Error('Connection closed'))
        }
        const timer = setTimeout(
            () => {
                signal.removeEventListener('abort', abort)
                resolve()
            },
            Math.max(0, ms)
        )
        signal.addEventListener('abort', abort, { once: true })
    })
}
export class NetworkPacer {
    private next = 0
    constructor(
        private kbps: number,
        private signal: AbortSignal
    ) {}
    async pace(bytes: number) {
        if (!this.kbps) return
        const now = performance.now()
        this.next = Math.max(now, this.next) + (bytes * 8) / this.kbps
        await waitNetwork(Math.ceil(this.next - now), this.signal)
    }
}
export function networkTransform(kbps: number, socket: Duplex) {
    const controller = new AbortController(),
        pacer = new NetworkPacer(kbps, controller.signal)
    const chunkSize = Math.max(4096, Math.min(65536, Math.floor((kbps * 1000) / 8 / 4)))
    const stream = new Transform({
        transform(chunk: Buffer, _encoding, done) {
            void (async () => {
                for (let offset = 0; offset < chunk.length; offset += chunkSize) {
                    const part = chunk.subarray(offset, offset + chunkSize)
                    await pacer.pace(part.length)
                    if (controller.signal.aborted) throw new Error('Connection closed')
                    this.push(part)
                }
            })().then(() => done(), done)
        },
        destroy(error, done) {
            controller.abort()
            socket.removeListener('close', close)
            done(error)
        }
    })
    const close = () => stream.destroy()
    socket.once('close', close)
    if (socket.destroyed) stream.destroy()
    return stream
}
