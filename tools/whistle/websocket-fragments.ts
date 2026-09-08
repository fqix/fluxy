import type WebSocket from 'ws'

// ws exposes complete messages only. Keep its validated data-frame boundaries
// before dataMessage clears them, including empty continuation frames. This
// adapter depends on the ws version pinned in tools/whistle/package-lock.json;
// compression must remain disabled on both ends of the proxy.
interface FragmentReceiver {
    _payloadLength: number
    _fin: boolean
    dataMessage(callback: (error?: Error) => void): void
}

export function onFragmentedMessage(
    socket: WebSocket,
    listener: (data: Buffer, binary: boolean, lengths: number[]) => void
) {
    if (socket.extensions) throw new Error('Fragment forwarding requires uncompressed WebSockets')
    const receiver = (socket as WebSocket & { _receiver: FragmentReceiver })._receiver
    if (typeof receiver?.dataMessage !== 'function')
        throw new Error('Unsupported ws receiver for fragment forwarding')
    const original = receiver.dataMessage
    let lengths: number[] = []
    const messages: number[][] = []
    receiver.dataMessage = function (callback) {
        lengths.push(this._payloadLength)
        if (this._fin) {
            messages.push(lengths)
            lengths = []
        }
        original.call(this, callback)
    }
    socket.on('message', (data, binary) => {
        const fragments = messages.shift()!
        listener(data as Buffer, binary, fragments)
    })
    socket.once('close', () => {
        receiver.dataMessage = original
        messages.length = 0
        lengths = []
    })
}

export async function sendFragmentedMessage(
    socket: WebSocket,
    data: Buffer | string,
    binary: boolean,
    lengths: number[]
) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data)
    const originalSize = lengths.reduce((sum, length) => sum + length, 0)
    let offset = 0
    const send = (length: number, fin: boolean) =>
        new Promise<void>((resolve, reject) => {
            const fragment = body.subarray(offset, offset + length)
            offset += length
            socket.send(fragment, { binary, fin }, (error) => (error ? reject(error) : resolve()))
        })
    if (body.length === originalSize) {
        for (let index = 0; index < lengths.length; index++)
            await send(lengths[index], index === lengths.length - 1)
        return
    }
    // Message hooks may change the size. Retain the original boundaries where
    // possible and split any extra bytes without increasing the largest frame.
    let largest = 1
    for (const length of lengths) {
        largest = Math.max(largest, length)
        const size = Math.min(length, body.length - offset)
        await send(size, offset + size === body.length)
        if (offset === body.length) return
    }
    while (offset < body.length) {
        const size = Math.min(largest, body.length - offset)
        await send(size, offset + size === body.length)
    }
}
