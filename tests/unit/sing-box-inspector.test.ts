import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { ensureCertificate } from '../../src/main/certificates/certificates'
import { bundledCorePath } from '../../src/main/capture/sing-box-proxy'
import { ProxyWire } from '../../src/main/capture/proxy-wire'

async function unusedPort() {
    const listener = net.createServer()
    listener.listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const port = (listener.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => listener.close(() => resolve()))
    return port
}

function config(port: number) {
    return {
        log: { output: 'stderr' },
        services: [{ type: 'fluxy-inspector', tag: 'inspector' }],
        inbounds: [{ type: 'fluxy-mixed', tag: 'proxy', listen: '127.0.0.1', listen_port: port }],
        outbounds: [{ type: 'fluxy-inspect', tag: 'inspect', inspector: 'inspector' }],
        route: { final: 'inspect', rules: [{ network: 'udp', action: 'reject' }] }
    }
}

it('runs the inspector service in sing-box without a TCP inspection hop or competing stdin reader', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-inspector-'))
    const port = await unusedPort()
    await ensureCertificate(directory)
    const path = join(directory, 'config.json')
    await writeFile(path, JSON.stringify(config(port)))
    // A configuration check must not wait for an IPC start message or consume stdin.
    await promisify(execFile)(bundledCorePath(), ['check', '-c', path], { timeout: 5000 })
    const child = spawn(bundledCorePath(), ['run', '-c', path], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FLUXY_HELPER_STDIN: '1', FLUXY_HELPER_PARENT: String(process.pid) }
    })
    let stderr = ''
    child.stderr.on('data', (data) => (stderr += data))
    child.stdin.on('error', () => {})
    const exited = new Promise<number | null>((resolve, reject) => {
        child.once('exit', resolve)
        child.once('error', reject)
    })
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 10000)
    const wire = new ProxyWire(child.stdin)
    const requests: any[] = []
    const messages: any[] = []
    const ready = new Promise<any>((resolve, reject) => {
        child.on('exit', () => reject(new Error(stderr || 'Inspector exited before readiness')))
        child.on('error', reject)
        child.stdout.on('data', (data) => {
            try {
                wire.receive(data)
            } catch (error) {
                reject(error)
            }
        })
        wire.on('message', (message) => {
            messages.push(message)
            if (message.type === 'ready') resolve(message)
            if (message.type === 'request') {
                requests.push(message)
                wire.send({
                    type: 'request-result',
                    id: message.id,
                    local: true,
                    status: 200,
                    headers: { 'content-type': 'text/plain' }
                })
                wire.send({
                    type: 'chunk',
                    stream: message.id + ':request:out',
                    data: Buffer.from('embedded inspector')
                })
            }
            if (message.type === 'credit' && message.stream.endsWith(':request:out'))
                wire.send({ type: 'end', stream: message.stream })
        })
    })
    try {
        wire.send({
            type: 'start',
            ingressPort: port,
            root: {
                certificate: await readFile(join(directory, 'certs/ca.pem'), 'utf8'),
                key: await readFile(join(directory, 'keys/ca.private.key'), 'utf8')
            }
        })
        expect(await ready).toMatchObject({ type: 'ready', port, in_process: true })
        // IPC readiness is emitted after inspector initialization. Wait for the
        // normal sing-box startup marker before connecting to the public inbound.
        if (!stderr.includes('sing-box started ('))
            await new Promise<void>((resolve, reject) => {
                const check = () => {
                    if (stderr.includes('sing-box started (')) {
                        child.stderr.off('data', check)
                        resolve()
                    }
                }
                child.stderr.on('data', check)
                child.once('exit', () => reject(new Error(stderr)))
            })
        let localPort: number | undefined
        const response = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
            const request = http.get(
                {
                    host: '127.0.0.1',
                    port,
                    path: 'http://example.com/test',
                    agent: false,
                    headers: { host: 'example.com', 'X-Fluxy-Source': '1.2.3.4:9999' }
                },
                (response) => {
                    let body = ''
                    response.on('data', (data) => (body += data))
                    response.on('end', () => resolve({ status: response.statusCode, body }))
                    response.on('error', reject)
                }
            )
            request.on('socket', (socket) =>
                socket.once('connect', () => (localPort = socket.localPort))
            )
            request.on('error', reject)
        })
        expect(response).toEqual({ status: 200, body: 'embedded inspector' })
        expect(requests).toHaveLength(1)
        expect(requests[0].socket).toMatchObject({
            remoteAddress: '127.0.0.1',
            remotePort: localPort,
            localPort: port
        })
        expect(messages.some((message) => message.type === 'failure')).toBe(false)
        child.stdin.end()
        expect(await exited, stderr).toBe(0)
        expect(child.signalCode).toBeNull()
    } finally {
        clearTimeout(watchdog)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await exited.catch(() => {})
        await rm(directory, { recursive: true, force: true })
    }
})

it.each(['stdout', 'missing-service', 'duplicate-service'] as const)(
    'rejects invalid inspector setup: %s',
    async (scenario) => {
        const directory = await mkdtemp(join(tmpdir(), 'fluxy-inspector-invalid-'))
        try {
            const options = config(await unusedPort())
            if (scenario === 'stdout') options.log.output = 'stdout'
            if (scenario === 'missing-service') options.outbounds[0].inspector = 'missing'
            if (scenario === 'duplicate-service')
                options.services.push({ type: 'fluxy-inspector', tag: 'second' })
            const path = join(directory, 'config.json')
            await writeFile(path, JSON.stringify(options))
            await expect(
                promisify(execFile)(bundledCorePath(), ['run', '-c', path], { timeout: 5000 })
            ).rejects.toThrow(
                scenario === 'stdout'
                    ? 'reserves stdout'
                    : scenario === 'missing-service'
                      ? 'unknown fluxy-inspector'
                      : 'only one fluxy-inspector'
            )
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    }
)
