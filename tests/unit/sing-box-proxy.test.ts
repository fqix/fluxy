import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { Store } from '../../src/main/storage/store'
import { ProxyEngine } from '../../src/main/capture/proxy'
import { CaptureController } from '../../src/main/capture/capture'
import { unusedPort } from '../../src/main/tun/tun'

let directory: string
let engine: ProxyEngine
let store: Store

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fluxy-ingress-test-'))
    store = new Store(directory)
    store.settings.port = await unusedPort()
    store.settings.captureMode = 'proxy'
    engine = new ProxyEngine(store, () => {})
})
afterEach(async () => {
    await engine?.stop()
    await rm(directory, { recursive: true, force: true })
})

function internal() {
    return engine as unknown as {
        ingress: { child: ChildProcess }
        proxy: { port: number }
    }
}
async function listening(port: number) {
    return new Promise<boolean>((resolve) => {
        const socket = net.connect(port, '127.0.0.1')
        socket.on('connect', () => {
            socket.destroy()
            resolve(true)
        })
        socket.on('error', () => resolve(false))
    })
}

it('uses sing-box on the public port and a private ephemeral inspection port', async () => {
    await engine.start()
    const { ingress, proxy } = internal()
    expect(ingress.child.spawnfile).toMatch(/fluxy-core(?:\.exe)?$/)
    expect(proxy.port).not.toBe(store.settings.port)
    expect(await listening(proxy.port)).toBe(true)
    const socket = net.connect(store.settings.port, '127.0.0.1')
    await once(socket, 'connect')
    socket.write(Buffer.from([5, 1, 0]))
    expect((await once(socket, 'data'))[0]).toEqual(Buffer.from([5, 0]))
    socket.destroy()
    await Promise.all([engine.stop(), engine.stop()])
    expect(await listening(store.settings.port)).toBe(false)
    expect(await listening(proxy.port)).toBe(false)
    expect((await readdir(directory)).filter((name) => name.startsWith('proxy-core-'))).toEqual([])
})

it('rolls back a failed core start without enabling the system proxy', async () => {
    engine = new ProxyEngine(store, () => {}, undefined, join(directory, 'missing-core'))
    const systemProxy = { enabled: false, set: vi.fn(async () => {}) }
    const capture = new CaptureController(
        () => store.settings,
        engine,
        { status: { state: 'stopped' }, start: async () => {}, stop: async () => {} },
        systemProxy
    )
    await expect(capture.start()).rejects.toThrow()
    expect(systemProxy.set).not.toHaveBeenCalled()
    expect(engine.running).toBe(false)
    expect(internal().proxy).toBeUndefined()
    expect(await listening(store.settings.port)).toBe(false)
})

it('keeps the TUN inspection listener HTTP-only while sing-box owns SOCKS', async () => {
    store.settings.captureMode = 'tun'
    store.settings.ssl = true
    store.settings.sslHosts = ['example.com']
    engine.setTransportEgress('http://127.0.0.1:1')
    await engine.start()
    const exchange = async (request: Buffer) => {
        const socket = net.connect(store.settings.port, '127.0.0.1')
        socket.setTimeout(2000, () => socket.destroy(new Error('Handshake timed out')))
        try {
            await once(socket, 'connect')
            socket.write(request)
            return ((await once(socket, 'data'))[0] as Buffer).toString('ascii')
        } finally {
            socket.destroy()
        }
    }
    expect(
        await exchange(
            Buffer.from('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n')
        )
    ).toMatch(/^HTTP\/1\.[01] 200/)
    // Terminate the invalid HTTP header so rejection does not depend on a timeout.
    expect(await exchange(Buffer.from([5, 1, 0, 13, 10, 13, 10]))).toMatch(/^HTTP\/1\.[01] 400/)
})

it('restores system proxy and closes inspection after the ingress process crashes', async () => {
    const systemProxy = {
        enabled: false,
        set: vi.fn(async (enabled: boolean) => {
            systemProxy.enabled = enabled
        })
    }
    const capture = new CaptureController(
        () => store.settings,
        engine,
        { status: { state: 'stopped' }, start: async () => {}, stop: async () => {} },
        systemProxy
    )
    engine.onFailure = () => capture.stop()
    await capture.start()
    const { ingress, proxy } = internal()
    expect(systemProxy.enabled).toBe(true)
    ingress.child.kill('SIGKILL')
    await vi.waitFor(() => expect(engine.running).toBe(false))
    expect(systemProxy.enabled).toBe(false)
    expect(await listening(store.settings.port)).toBe(false)
    expect(await listening(proxy.port)).toBe(false)
})

it('closes both listeners when their Electron owner dies without cleanup', async () => {
    const child = spawn(
        process.execPath,
        [
            '--import',
            'tsx',
            join(process.cwd(), 'tests/fixtures/proxy-ingress-owner.ts'),
            directory
        ],
        {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: process.env
        }
    )
    try {
        const ports = await new Promise<{ public: number; internal: number }>((resolve, reject) => {
            let stdout = '',
                stderr = ''
            const timeout = setTimeout(
                () => reject(new Error(`Owner startup timeout: ${stderr}`)),
                15000
            )
            child.stderr.on('data', (chunk) => {
                stderr += chunk
            })
            child.on('error', (error) => {
                clearTimeout(timeout)
                reject(error)
            })
            child.on('exit', () => {
                clearTimeout(timeout)
                reject(new Error(stderr))
            })
            child.stdout.on('data', (chunk) => {
                stdout += chunk
                if (stdout.includes('\n')) {
                    clearTimeout(timeout)
                    resolve(JSON.parse(stdout.trim()))
                }
            })
        })
        expect(await listening(ports.public)).toBe(true)
        expect(await listening(ports.internal)).toBe(true)
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
        await vi.waitFor(
            async () => {
                expect(await listening(ports.public)).toBe(false)
                expect(await listening(ports.internal)).toBe(false)
            },
            { timeout: 12000 }
        )
    } finally {
        child.kill('SIGKILL')
    }
})
