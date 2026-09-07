import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { StreamChannel } from '../../src/main/capture/whistle-ipc'

it('backpressures an unread body and resumes without losing bytes', async () => {
    let chunks = 0
    const sender = new StreamChannel((message) => {
        if (message.type === 'chunk') chunks++
        queueMicrotask(() => receiver.receive(message))
    })
    const receiver = new StreamChannel((message) => queueMicrotask(() => sender.receive(message)))
    const input = Buffer.alloc(256 * 1024, 173)
    const reader = receiver.reader('body')
    const sent = sender.pipe('body', Readable.from([input]))
    try {
        await delay(20)
        expect(chunks).toBe(1)
        const received: Buffer[] = []
        for await (const chunk of reader) received.push(Buffer.from(chunk))
        await sent
        expect(Buffer.concat(received)).toEqual(input)
    } finally {
        sender.close()
        receiver.close()
    }
})

it('releases a producer cancelled while waiting for consumer credit', async () => {
    const sender = new StreamChannel((message) => queueMicrotask(() => receiver.receive(message)))
    const receiver = new StreamChannel((message) => queueMicrotask(() => sender.receive(message)))
    receiver.reader('cancelled:body')
    const sent = sender.pipe('cancelled:body', Readable.from([Buffer.alloc(256 * 1024)]))
    await delay(20)
    sender.cancel('cancelled:')
    receiver.cancel('cancelled:')
    await expect(sent).resolves.toBeUndefined()
    sender.close()
    receiver.close()
})
