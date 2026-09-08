import { EventEmitter } from 'node:events'
import type { Writable } from 'node:stream'

// Inherited stdin/stdout carry length-prefixed JSON; binary values use base64.
// No control port is exposed to other local processes or captured applications.
const MAX_MESSAGE = 144 * 1024 * 1024
export class ProxyWire extends EventEmitter {
    private header = Buffer.alloc(4)
    private headerUsed = 0
    private body?: Buffer
    private bodyUsed = 0
    constructor(private output: Writable) {
        super()
    }
    send(message: Record<string, unknown>) {
        // Convert before JSON.stringify invokes Buffer.toJSON, which would make
        // a large WebSocket message into millions of intermediate array values.
        const encode = (value: any): any => {
            if (Buffer.isBuffer(value)) return { $bytes: value.toString('base64') }
            if (Array.isArray(value)) return value.map(encode)
            if (value && typeof value === 'object')
                return Object.fromEntries(
                    Object.entries(value).map(([key, item]) => [key, encode(item)])
                )
            return value
        }
        const body = Buffer.from(JSON.stringify(encode(message)))
        if (body.length > MAX_MESSAGE) throw new Error('Proxy IPC message exceeds the size limit')
        const header = Buffer.allocUnsafe(4)
        header.writeUInt32BE(body.length)
        this.output.write(Buffer.concat([header, body]))
    }
    receive(data: Buffer) {
        let offset = 0
        while (offset < data.length) {
            if (!this.body) {
                const count = Math.min(4 - this.headerUsed, data.length - offset)
                data.copy(this.header, this.headerUsed, offset, offset + count)
                this.headerUsed += count
                offset += count
                if (this.headerUsed < 4) return
                const length = this.header.readUInt32BE(0)
                if (!length || length > MAX_MESSAGE)
                    throw new Error('Invalid proxy IPC frame length')
                this.body = Buffer.allocUnsafe(length)
                this.bodyUsed = 0
            }
            const count = Math.min(this.body.length - this.bodyUsed, data.length - offset)
            data.copy(this.body, this.bodyUsed, offset, offset + count)
            this.bodyUsed += count
            offset += count
            if (this.bodyUsed < this.body.length) return
            const message = JSON.parse(this.body.toString(), (_key, value) =>
                value && typeof value.$bytes === 'string'
                    ? Buffer.from(value.$bytes, 'base64')
                    : value
            )
            this.body = undefined
            this.headerUsed = 0
            this.emit('message', message)
        }
    }
}
