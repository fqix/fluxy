import type WebSocket from 'ws'

// Fixture sender for exercising frame boundaries through the production proxy.
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
