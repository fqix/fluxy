import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export function bundledCorePath() {
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    const binary = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box'
    return resources ? join(resources, 'core', binary) : resolve('build/electron-core', binary)
}

export function proxyIngressConfig(host: string, port: number) {
    return {
        log: { level: 'info', output: 'stderr', disabled: false, timestamp: false },
        services: [{ type: 'fluxy-inspector', tag: 'inspector' }],
        inbounds: [{ type: 'fluxy-mixed', tag: 'proxy', listen: host, listen_port: port }],
        outbounds: [{ type: 'fluxy-inspect', tag: 'inspect', inspector: 'inspector' }],
        // UDP cannot be inspected by the HTTP engine. Never silently bypass it.
        route: { final: 'inspect', rules: [{ network: 'udp', action: 'reject' }] }
    }
}

/** Prepare a private config; stdout is reserved for the inspector IPC stream. */
export async function prepareProxyCore(
    corePath: string,
    directory: string,
    host: string,
    port: number
) {
    const manifest = JSON.parse(await readFile(corePath + '.build.json', 'utf8'))
    const hash = createHash('sha256')
        .update(await readFile(corePath))
        .digest('hex')
    if (
        manifest.version !== '1.14.0' ||
        (manifest.signedSHA256 ?? manifest.unsignedSHA256) !== hash
    )
        throw new Error('Bundled proxy core integrity check failed; rebuild Fluxy')
    const temporary = await mkdtemp(join(directory, 'proxy-core-'))
    try {
        const config = join(temporary, 'config.json')
        await writeFile(config, JSON.stringify(proxyIngressConfig(host, port)), { mode: 0o600 })
        return { directory: temporary, config }
    } catch (error) {
        await rm(temporary, { recursive: true, force: true })
        throw error
    }
}
