import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { bundledCorePath } from '../../src/main/capture/sing-box-proxy'

it('builds the reduced CLI and records the applied patches', async () => {
    const binary = bundledCorePath()
    const { stdout } = await promisify(execFile)(binary, ['--help'])
    expect(stdout).toContain('sing-box [command]')
    expect(stdout).toContain('format')
    expect(stdout).not.toMatch(/^\s+api\s/m)
    const manifest = JSON.parse(await readFile(binary + '.build.json', 'utf8'))
    expect(manifest.profile).toBe('fluxy-transport')
    expect(manifest.tags).toEqual(['with_gvisor', 'with_fluxy'])
    const patches = (await readdir('third_party/patches/sing-box'))
        .filter((name) => name.endsWith('.patch'))
        .sort()
    expect(patches.length).toBeGreaterThan(0)
    expect(manifest.patches.map((patch: { name: string }) => patch.name)).toEqual(patches)
    for (const module of [
        'github.com/sagernet/sing-cloudflared',
        'github.com/sagernet/sing-quic',
        'github.com/sagernet/tailscale',
        'github.com/sagernet/wireguard-go',
        'golang.zx2c4.com/wireguard/wgctrl',
        'google.golang.org/grpc'
    ])
        expect(Object.hasOwn(manifest.modules, module), module).toBe(false)
    for (const patch of manifest.patches) {
        const source = await readFile(join('third_party/patches/sing-box', patch.name))
        expect(patch.sha256).toBe(createHash('sha256').update(source).digest('hex'))
    }
})

it.each(['after startup', 'during startup'] as const)(
    'closes the upstream service on helper pipe EOF %s',
    async (when) => {
        const directory = await mkdtemp(join(tmpdir(), 'fluxy-sing-box-'))
        const config = join(directory, 'config.json')
        await writeFile(config, JSON.stringify({ log: { level: 'info', disabled: false } }))
        const child = spawn(bundledCorePath(), ['run', '-c', config], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                FLUXY_HELPER_PARENT: String(process.pid),
                FLUXY_HELPER_STDIN: '1'
            }
        })
        let output = ''
        child.stdout.on('data', (data) => (output += data))
        child.stderr.on('data', (data) => {
            output += data
            if (when === 'after startup' && output.includes('sing-box started (')) child.stdin.end()
        })
        child.stdin.on('error', () => {})
        const exit = new Promise<number | null>((resolve, reject) => {
            child.once('error', reject)
            child.once('exit', resolve)
        })
        const timeout = setTimeout(() => child.kill('SIGKILL'), 8000)
        try {
            if (when === 'during startup') child.stdin.end()
            const code = await exit
            expect(child.signalCode, output).toBeNull()
            if (when === 'after startup') expect(code, output).toBe(0)
            else expect([0, 1], output).toContain(code)
        } finally {
            clearTimeout(timeout)
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
            await rm(directory, { recursive: true, force: true })
        }
    }
)

it('rejects a missing helper owner before starting a service', async () => {
    await expect(
        promisify(execFile)(bundledCorePath(), ['run'], {
            env: { ...process.env, FLUXY_HELPER_PARENT: 'invalid' }
        })
    ).rejects.toThrow('helper parent is no longer alive')
})
