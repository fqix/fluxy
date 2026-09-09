import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export function bundledCorePath() {
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    const binary = process.platform === 'win32' ? 'fluxy-core.exe' : 'fluxy-core'
    return resources ? join(resources, 'core', binary) : resolve('build/electron-core', binary)
}

export function proxyIngressConfig(host: string, port: number, inspectPort: number, token: string) {
    return {
        log: { level: 'info', disabled: false, timestamp: false },
        inbounds: [{ type: 'fluxy-mixed', tag: 'proxy', listen: host, listen_port: port }],
        outbounds: [{ type: 'fluxy-inspect', tag: 'inspect', server_port: inspectPort, token }],
        // UDP cannot be inspected by the HTTP engine. Never silently bypass it.
        route: { final: 'inspect', rules: [{ network: 'udp', action: 'reject' }] }
    }
}

/** Owns the public HTTP/SOCKS listener; the inspection server stays on loopback. */
export class SingBoxProxy {
    private child?: ChildProcess
    private directory?: string
    private stopping?: Promise<void>

    constructor(
        private corePath: string,
        private onFailure: (error: Error) => void
    ) {}

    async start(directory: string, host: string, port: number, inspectPort: number, token: string) {
        const manifest = JSON.parse(await readFile(this.corePath + '.build.json', 'utf8'))
        const hash = createHash('sha256')
            .update(await readFile(this.corePath))
            .digest('hex')
        if (
            manifest.version !== '1.14.0' ||
            (manifest.signedSHA256 ?? manifest.unsignedSHA256) !== hash
        )
            throw new Error('Bundled proxy core integrity check failed; rebuild Fluxy')
        this.directory = await mkdtemp(join(directory, 'proxy-core-'))
        try {
            const config = join(this.directory, 'config.json')
            await writeFile(
                config,
                JSON.stringify(proxyIngressConfig(host, port, inspectPort, token)),
                {
                    mode: 0o600
                }
            )
            const child = (this.child = spawn(this.corePath, ['run', '-c', config], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
                // The core already supports pipe-EOF shutdown, including parent crashes.
                env: {
                    ...process.env,
                    FLUXY_HELPER_STDIN: '1',
                    FLUXY_HELPER_PARENT: String(process.pid)
                }
            }))
            await new Promise<void>((resolve, reject) => {
                let ready = false
                let output = ''
                const timer = setTimeout(
                    () => reject(new Error('sing-box proxy startup timed out')),
                    15000
                )
                const fail = (error: Error) => {
                    clearTimeout(timer)
                    if (!ready) reject(error)
                    else if (this.child === child) this.onFailure(error)
                }
                const log = (chunk: Buffer) => {
                    output = (output + chunk.toString()).slice(-8192)
                    // Emitted by Box.Start only after all listeners have started.
                    if (!ready && output.includes('sing-box started (')) {
                        ready = true
                        clearTimeout(timer)
                        resolve()
                    }
                }
                child.stdout!.on('data', log)
                child.stderr!.on('data', log)
                child.on('error', fail)
                child.stdin!.on('error', fail)
                child.on('exit', (code, signal) =>
                    fail(new Error(`sing-box proxy exited (${signal ?? code}): ${output.trim()}`))
                )
            })
        } catch (error) {
            await this.stop()
            throw error
        }
    }

    stop(): Promise<void> {
        if (this.stopping) return this.stopping
        this.stopping = this.close().finally(() => {
            this.stopping = undefined
        })
        return this.stopping
    }

    private async close() {
        const child = this.child
        this.child = undefined
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
                child.once('exit', () => {
                    clearTimeout(timer)
                    resolve()
                })
                child.stdin?.end()
                child.kill()
            })
        }
        if (this.directory) await rm(this.directory, { recursive: true, force: true })
        this.directory = undefined
    }
}
