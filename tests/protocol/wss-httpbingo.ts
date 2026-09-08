import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { rootCertificates, type TLSSocket } from 'node:tls'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { startProxy } from './engine.js'

// Manual external integration test; deliberately excluded from the offline unit suite.
const target = 'wss://httpbingo.org/websocket/echo?max_fragment_size=2048&max_message_size=10240'
const cases = [
    { name: 'text', body: Buffer.from('Fluxy WSS echo — 中文'), binary: false, fragment: 2048 },
    { name: 'binary', body: Buffer.from([0, 255, 1, 128, 10]), binary: true, fragment: 2048 },
    { name: 'fragment-boundary-2048', body: Buffer.alloc(2048, 65), binary: false, fragment: 2048 },
    { name: 'fragmented-text-4096', body: Buffer.alloc(4096, 66), binary: false, fragment: 2048 },
    {
        name: 'fragmented-binary-10240',
        body: Buffer.alloc(10240, 0xa5),
        binary: true,
        fragment: 2048
    },
    {
        name: 'oversized-fragment-2049',
        body: Buffer.alloc(2049, 67),
        binary: false,
        fragment: 2049,
        close: 1002
    },
    {
        name: 'oversized-message-10241',
        body: Buffer.alloc(10241, 68),
        binary: false,
        fragment: 2048,
        close: 1009
    }
]
const external = process.env.FLUXY_WSS_PROXY
const proxy = external ? undefined : await startProxy('', [])
const proxyURL = external || `http://127.0.0.1:${proxy!.port}`
const ca = external ? await readFile(process.env.FLUXY_WSS_CA!, 'utf8') : proxy!.ca
const results: Record<string, unknown>[] = []

async function check(mode: 'direct' | 'proxy', test: (typeof cases)[number]) {
    const agent = mode === 'proxy' ? new HttpsProxyAgent(proxyURL) : undefined
    const socket = new WebSocket(target, {
        agent,
        ...(mode === 'proxy' ? { ca: [...rootCertificates, ca] } : {}),
        perMessageDeflate: false,
        handshakeTimeout: 10000,
        maxPayload: 64 * 1024
    })
    socket.on('error', () => {})
    const detail: Record<string, unknown> = {
        mode,
        case: test.name,
        bytes: test.body.length,
        fragment: test.fragment
    }
    socket.once('upgrade', (response) => {
        detail.status = response.statusCode
        detail.issuer = (response.socket as TLSSocket).getPeerCertificate().issuer?.CN
        detail.tlsAuthorized = (response.socket as TLSSocket).authorized
    })
    const ended = new Promise<{ code: number; reason: string }>((resolve) =>
        socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    )
    const echoed = new Promise<{ data: Buffer; binary: boolean }>((resolve) =>
        socket.once('message', (data, binary) =>
            resolve({ data: Buffer.from(data as Buffer), binary })
        )
    )
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error('WSS test timed out'))
            socket.terminate()
        }, 15000)
    })
    try {
        await Promise.race([once(socket, 'open'), timeout])
        assert.equal(detail.status, 101)
        assert.equal(detail.tlsAuthorized, true)
        for (let offset = 0; offset < test.body.length; offset += test.fragment) {
            const end = Math.min(offset + test.fragment, test.body.length)
            socket.send(test.body.subarray(offset, end), {
                binary: test.binary,
                fin: end === test.body.length
            })
        }
        const result = await Promise.race([
            echoed.then((value) => ({ type: 'echo' as const, ...value })),
            ended.then((value) => ({ type: 'close' as const, ...value })),
            timeout
        ])
        if (test.close) {
            assert.equal(result.type, 'close', 'Oversized input should be rejected')
            if (result.type === 'close') {
                detail.closeCode = result.code
                detail.closeReason = result.reason
                assert.equal(result.code, test.close)
            }
        } else {
            if (result.type === 'close')
                throw new Error(`Closed before echo: ${result.code} ${result.reason}`)
            assert.deepEqual(result.data, test.body)
            assert.equal(result.binary, test.binary)
            detail.echoSHA256 = createHash('sha256').update(result.data).digest('hex')
            socket.close(1000, 'test complete')
            const close = await Promise.race([ended, timeout])
            detail.closeCode = close.code
            assert.equal(close.code, 1000)
        }
        detail.passed = true
    } catch (error) {
        detail.passed = false
        detail.error = error instanceof Error ? error.message : String(error)
    } finally {
        clearTimeout(timer!)
        socket.terminate()
        agent?.destroy()
    }
    console.log(
        `${detail.passed ? 'PASS' : 'FAIL'} ${mode} ${test.name}${detail.error ? ': ' + detail.error : ''}`
    )
    return detail
}

try {
    for (const test of cases) {
        if (process.env.FLUXY_WSS_SKIP_DIRECT !== '1') results.push(await check('direct', test))
        results.push(await check('proxy', test))
    }
    await delay(500)
    const captures = proxy
        ? (await proxy.snapshot())
              .filter((item) => item.url === target)
              .map((item) => ({
                  id: item.id,
                  url: item.url,
                  status: item.status,
                  aborted: item.aborted,
                  frames: item.frames.map((frame) => ({
                      direction: frame.isClient ? 'send' : 'receive',
                      opcode: frame.opcode,
                      bytes: Buffer.from(frame.data, 'base64').length,
                      sha256: createHash('sha256')
                          .update(Buffer.from(frame.data, 'base64'))
                          .digest('hex')
                  }))
              }))
        : undefined
    const successfulEchoes = cases.filter(
        (test) =>
            !test.close &&
            results.some(
                (result) => result.mode === 'proxy' && result.case === test.name && result.passed
            )
    )
    const captureVerified = proxy
        ? successfulEchoes.every((test) => {
              const hash = createHash('sha256').update(test.body).digest('hex')
              return captures!.some(
                  (item) =>
                      item.status === 101 &&
                      ['send', 'receive'].every((direction) =>
                          item.frames.some(
                              (frame) => frame.direction === direction && frame.sha256 === hash
                          )
                      )
              )
          })
        : undefined
    if (proxy)
        console.log(
            `Capture verification: ${captureVerified ? 'PASS' : 'FAIL'}; ${captures!.length} WSS sessions`
        )
    const report = {
        target,
        timestamp: new Date().toISOString(),
        proxy: proxyURL,
        results,
        captures,
        captureVerified
    }
    const directory = new URL('../../test-results/protocol/', import.meta.url)
    await mkdir(directory, { recursive: true })
    await writeFile(
        new URL(external ? 'wss-httpbingo-live.json' : 'wss-httpbingo.json', directory),
        JSON.stringify(report, null, 2)
    )
    if (results.some((result) => !result.passed) || captureVerified === false) process.exitCode = 1
} finally {
    await proxy?.stop()
}
