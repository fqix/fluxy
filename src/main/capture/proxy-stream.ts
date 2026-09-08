import { Readable, Writable } from 'node:stream'

// A bounded, credit-based stream over the private child-process IPC channel.
// One chunk per stream is in flight; paused breakpoints cannot grow an IPC queue.
export class StreamChannel {
    private readers = new Map<string, Readable>()
    private credits = new Map<string, () => void>()
    private acknowledgements = new Map<string, () => void>()
    private sending = new Map<string, { cancelled: boolean; source: Readable }>()
    constructor(private send: (message: Record<string, unknown>) => void) {}
    receive(message: any) {
        const id = message.stream as string
        if (message.type === 'credit') {
            const release = this.credits.get(id)
            this.credits.delete(id)
            release?.()
        } else if (message.type === 'chunk') {
            const reader = this.readers.get(id)
            if (!reader) return
            const ack = () => this.send({ type: 'credit', stream: id })
            if (reader.push(Buffer.from(message.data))) ack()
            else this.acknowledgements.set(id, ack)
        } else if (message.type === 'end') {
            const reader = this.readers.get(id)
            if (reader) {
                Object.assign(reader, { trailers: message.trailers ?? {} })
                reader.push(null)
            }
            this.readers.delete(id)
        }
    }
    reader(id: string): Readable {
        const channel = this
        const reader = new Readable({
            highWaterMark: 64 * 1024,
            read() {
                channel.acknowledgements.get(id)?.()
                channel.acknowledgements.delete(id)
            }
        })
        this.readers.set(id, reader)
        return reader
    }
    async pipe(id: string, source: Readable & { trailers?: unknown }) {
        const state = { cancelled: false, source }
        this.sending.set(id, state)
        try {
            for await (const bytes of source) {
                if (state.cancelled) return
                const buffer = Buffer.from(bytes)
                for (let offset = 0; offset < buffer.length; offset += 65536) {
                    await new Promise<void>((resolve) => {
                        this.credits.set(id, resolve)
                        this.send({
                            type: 'chunk',
                            stream: id,
                            data: buffer.subarray(offset, offset + 65536)
                        })
                    })
                    if (state.cancelled) return
                }
            }
            this.send({ type: 'end', stream: id, trailers: source.trailers })
        } catch (error) {
            if (!state.cancelled) throw error
        } finally {
            this.sending.delete(id)
            this.credits.delete(id)
        }
    }
    writer(id: string) {
        return new Writable({
            write: (data, _encoding, done) => {
                this.credits.set(id, () => done())
                this.send({ type: 'chunk', stream: id, data })
            },
            final: (done) => {
                this.send({ type: 'end', stream: id })
                done()
            }
        })
    }
    cancel(prefix: string) {
        for (const [id, state] of this.sending)
            if (id.startsWith(prefix)) {
                state.cancelled = true
                state.source.destroy()
            }
        for (const [id, reader] of this.readers)
            if (id.startsWith(prefix)) {
                reader.destroy()
                this.readers.delete(id)
            }
        for (const [id, release] of this.credits)
            if (id.startsWith(prefix)) {
                release()
                this.credits.delete(id)
            }
        for (const id of this.acknowledgements.keys())
            if (id.startsWith(prefix)) this.acknowledgements.delete(id)
    }
    close() {
        this.cancel('')
    }
}
