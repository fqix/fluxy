import https from 'node:https'
import net from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { ProxyEngine } from '../../src/main/capture/proxy'
import { Store } from '../../src/main/storage/store'

export interface Capture {
    id: string
    url: string
    useH2: boolean
    httpVersion?: string
    complete: boolean
    aborted: boolean
    request: string
    response: string
    requestBytes: number
    responseBytes: number
    status?: number
    headers: Record<string, string>
    trailers?: Record<string, string>
    frames: { isClient?: boolean; opcode?: number; data: string }[]
}
export async function startProxy(
    originCA: string,
    _targets: number | string[],
    configure?: (engine: ProxyEngine) => void
) {
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-protocol-'))
    const probe = net.createServer().listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const port = (probe.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const store = new Store(directory)
    Object.assign(store.settings, { port, ssl: true, sslHosts: ['*'], localhostOnly: true })
    const agent = originCA ? new https.Agent({ ca: originCA }) : undefined
    const engine = new ProxyEngine(store, () => {}, agent)
    configure?.(engine)
    try {
        await engine.start()
    } catch (error) {
        await engine.stop()
        await rm(directory, { recursive: true, force: true })
        throw error
    }
    return {
        engine,
        port,
        ca: await readFile(engine.certificatePath, 'utf8'),
        logs: () => engine.logs.map((entry) => entry.message).join('\n'),
        snapshot: async (): Promise<Capture[]> =>
            [...engine.transactions.values()].map((item) => ({
                id: item.id,
                url: item.url,
                useH2: item.httpVersion === '2.0',
                httpVersion: item.httpVersion,
                complete: item.state === 'completed',
                aborted: item.state === 'error',
                request: item.requestBase64 ?? Buffer.from(item.requestBody).toString('base64'),
                response: item.responseBase64 ?? Buffer.from(item.responseBody).toString('base64'),
                requestBytes: item.requestBytes,
                responseBytes: item.responseBytes,
                status: item.status,
                headers: item.responseHeaders,
                trailers: item.responseTrailers,
                frames: item.frames.map((frame) => ({
                    isClient: frame.direction === 'send',
                    opcode: frame.binary ? 2 : 1,
                    data: Buffer.from(frame.body, frame.binary ? 'hex' : 'utf8').toString('base64')
                }))
            })),
        stop: async () => {
            await engine.stop()
            agent?.destroy()
            await rm(directory, { recursive: true, force: true })
        }
    }
}
