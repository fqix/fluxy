import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as cp from 'node:child_process'
import { promisify } from 'node:util'
import {
    mkdtemp,
    mkdir,
    readFile,
    writeFile,
    rm,
    copyFile,
    readdir,
    symlink
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { X509Certificate, randomBytes, createHash } from 'node:crypto'
import { HelperRPC, HelperService, installationScript } from '../../src/main/system/helper'
import { tunConfig } from '../../src/main/tun/tun-config'
import { tunSettingsSchema } from '../../src/shared/contracts/model'
import { ensureCertificate } from '../../src/main/certificates/certificates'
import { connect } from '../../src/main/tun/tun-bridge'
import { unusedPort } from '../../src/main/tun/tun'
import net from 'node:net'
const execute = promisify(cp.execFile)
const production = join(process.cwd(), 'build/electron-helper/fluxy-helper')
const core = join(process.cwd(), 'build/electron-core/sing-box')
function invoke(path: string, args: string[], input: string) {
    return new Promise<string>((resolve, reject) => {
        const worker = cp.spawn(path, args)
        let out = '',
            err = ''
        worker.stdout.on('data', (b) => (out += b))
        worker.stderr.on('data', (b) => (err += b))
        worker.on('error', reject)
        worker.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err))))
        worker.stdin.end(input)
    })
}
describe.skipIf(process.platform !== 'darwin')('privileged helper boundary (rootless)', () => {
    let directory: string, testHelper: string
    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), 'fluxy-helper-tests-'))
        testHelper = join(directory, 'helper-test')
        await execute(
            process.env.FLUXY_GO || 'go',
            ['build', '-tags=helper_testing', '-o', testHelper, '.'],
            { cwd: 'tools/helper', env: { ...process.env, CGO_ENABLED: '1' } }
        )
    }, 60000)
    afterAll(async () => {
        await rm(directory, { recursive: true, force: true })
    })
    const params = () => ({
        bridgePort: 18001,
        egressPort: 18002,
        password: randomBytes(32).toString('base64url'),
        interfaceName: 'utun2345',
        egressInterface: 'en0',
        socksPort: 0,
        routeCIDRs: ['203.0.113.0/24', '2001:db8::/32']
    })
    it('generates the exact pinned TUN configuration in the privileged boundary', async () => {
        for (const socksPort of [0, 7897]) {
            const p = { ...params(), socksPort }
            const result = await invoke(production, ['validate-tun'], JSON.stringify(p))
            expect(JSON.parse(result)).toEqual(
                tunConfig({ ...p, settings: tunSettingsSchema.parse(p) })
            )
            const config = join(directory, 'validated.json')
            await writeFile(config, result)
            await execute(core, ['check', '-c', config])
        }
    })
    it.each([
        { executable: '/bin/sh' },
        { egressInterface: 'en0; id' },
        { egressInterface: 'en0\n' },
        { bridgePort: true },
        { socksPort: 80 },
        { interfaceName: 'en0' },
        { password: 'short' },
        { routeCIDRs: ['1.2.3.4/999'] },
        { routeCIDRs: Array(129).fill('1.2.3.4/32') }
    ])('rejects unsafe or ambiguous privileged parameters: %j', async (patch) => {
        await expect(
            invoke(production, ['validate-tun'], JSON.stringify({ ...params(), ...patch }))
        ).rejects.toThrow()
    })
    it('accepts the actual public Fluxy CA but rejects malformed certificates', async () => {
        const path = await ensureCertificate(join(directory, 'certificates'))
        const der = new X509Certificate(await readFile(path)).raw.toString('base64')
        await expect(invoke(production, ['validate-ca'], der)).resolves.toBe('')
        await expect(
            invoke(
                testHelper,
                ['authorize-desktop'],
                JSON.stringify({ command: 'exit 0', certificate: der })
            )
        ).rejects.toThrow('Desktop authorization is disabled')
        await expect(
            invoke(
                testHelper,
                ['authorize-desktop'],
                JSON.stringify({ command: 'exit 0', certificate: 'invalid' })
            )
        ).rejects.toThrow()

        await expect(invoke(testHelper, ['trust-ca-desktop'], JSON.stringify(der))).rejects.toThrow(
            'CA mutations are disabled'
        )
        await expect(invoke(production, ['validate-ca'], 'dGVzdA==')).rejects.toThrow('Invalid CA')
        await expect(invoke(production, ['validate-ca'], 'A'.repeat(24001))).rejects.toThrow(
            'Invalid CA'
        )
    })
    it('runs desktop trust without elevation and permits retry after failure', async () => {
        const authorize = vi.fn()
        const helper = new HelperService(
            directory,
            testHelper,
            core,
            () => {},
            undefined,
            authorize
        )
        helper.status = { state: 'ready' }
        const internals = helper as unknown as {
            operation(method: string, params: unknown, timeout: number): Promise<void>
            assets(): Promise<unknown>
        }
        const operation = vi.spyOn(internals, 'operation').mockResolvedValue(undefined)
        vi.spyOn(internals, 'assets').mockResolvedValue({})
        const ca = new X509Certificate(
            await readFile(await ensureCertificate(join(directory, 'desktop-ca')))
        ).raw
        try {
            const first = helper.installCertificate(ca)
            expect(helper.installCertificate(ca)).toBe(first)
            await expect(helper.install()).rejects.toThrow('Wait for certificate trust')
            await expect(helper.repair()).rejects.toThrow('Wait for certificate trust')
            await expect(helper.uninstall()).rejects.toThrow('Wait for the current')
            await expect(helper.removeCertificate(ca)).rejects.toThrow('Wait for certificate trust')
            // The real test adapter refuses mutation before invoking native UI.
            await expect(first).rejects.toThrow('CA mutations are disabled')
            await expect(helper.installCertificate(ca)).rejects.toThrow('CA mutations are disabled')
            expect(operation).toHaveBeenCalledTimes(2)
            expect(operation).toHaveBeenCalledWith('ca.add', ca.toString('base64'), 30000)
            expect(authorize).not.toHaveBeenCalled()
            expect(helper.status.state).toBe('ready')
        } finally {
            helper.close()
        }
    })
    async function server() {
        const root = await mkdtemp(join(directory, 'daemon-'))
        const token = randomBytes(32).toString('hex')
        await writeFile(
            join(root, 'pairing.json'),
            JSON.stringify({
                uid: process.getuid!(),
                token,
                buildID: 'b'.repeat(64),
                caller: {
                    path: process.execPath,
                    sha256: createHash('sha256')
                        .update(await readFile(process.execPath))
                        .digest('hex'),
                    teamID: null
                }
            })
        )
        await symlink(core, join(root, 'sing-box'))
        const port = await unusedPort()
        const worker = cp.spawn(testHelper, [], {
            env: {
                ...process.env,
                FLUXY_HELPER_TEST_ROOT: root,
                FLUXY_HELPER_TEST_PORT: String(port)
            }
        })
        let errors = ''
        worker.stderr.on('data', (b) => (errors += b))
        const closed = once(worker, 'close')
        await expect
            .poll(async () => {
                if (worker.exitCode !== null) throw new Error(errors)
                return (await readdir(root)).includes('helper.sock')
            })
            .toBe(true)
        return { root, token, port, worker, closed }
    }
    it('returns the real core startup error through RPC and allows a clean retry', async () => {
        const { root, token, port, worker, closed } = await server()
        const rpc = new HelperRPC(join(root, 'helper.sock'), token)
        const occupied = net.createServer().listen(port, '127.0.0.1')
        await once(occupied, 'listening')
        try {
            const p = {
                ...params(),
                bridgePort: await unusedPort(),
                egressPort: await unusedPort()
            }
            // Configuration checking succeeds, but the real core fails when binding.
            await rpc.request('tun.start', p).catch((error) => {
                expect(String(error)).toContain('address already in use')
            })
            await expect.poll(async () => (await rpc.request('status')).tunRunning).toBe(false)
            const reply = await rpc.request('status')
            expect(reply.tunError).toContain('exit status 1')
            expect(reply.tunError).toContain('address already in use')
            expect(reply.tunError).not.toContain(p.password)
            await new Promise<void>((resolve) => occupied.close(() => resolve()))
            await rpc.request('tun.start', p)
            await expect
                .poll(async () => {
                    try {
                        ;(await connect(port)).destroy()
                        return true
                    } catch {
                        return false
                    }
                })
                .toBe(true)
            expect((await rpc.request('status')).tunError).toBe('')
            await rpc.request('tun.stop')
            expect((await rpc.request('status')).tunError).toBe('')
        } finally {
            occupied.close()
            rpc.close()
            worker.kill('SIGTERM')
            await closed
        }
    })
    it('authenticates requests, denies arbitrary operations, and stops the real core on disconnect', async () => {
        const serverState = await server()
        const { root, token, port, worker, closed } = serverState
        const bad = new HelperRPC(join(root, 'helper.sock'), randomBytes(32).toString('hex'))
        const rpc = new HelperRPC(join(root, 'helper.sock'), token)
        try {
            await expect(bad.request('status')).rejects.toThrow('closed')
            await expect(rpc.request('execute', { command: 'id' })).rejects.toThrow(
                'unsupported helper method'
            )
            await expect(rpc.request('tun.start', { ...params(), config: {} })).rejects.toThrow(
                'unknown field'
            )
            const p = {
                ...params(),
                bridgePort: await unusedPort(),
                egressPort: await unusedPort()
            }
            await rpc.request('tun.start', p)
            await expect
                .poll(async () => {
                    try {
                        ;(await connect(port)).destroy()
                        return true
                    } catch {
                        return false
                    }
                })
                .toBe(true)
            expect((await rpc.request('status')).tunRunning).toBe(true)
            rpc.close()
            await expect
                .poll(async () => {
                    try {
                        ;(await connect(port)).destroy()
                        return false
                    } catch {
                        return true
                    }
                })
                .toBe(true)
            expect((await rpc.request('status')).tunRunning).toBe(false)
            await rpc.request('tun.start', { ...p, egressPort: await unusedPort() })
            await rpc.request('tun.stop')
            expect((await rpc.request('status')).tunRunning).toBe(false)
        } finally {
            bad.close()
            rpc.close()
            worker.kill('SIGTERM')
            await closed
        }
    })
    it.each(['lease expiration', 'helper termination', 'helper SIGKILL'] as const)(
        'cleans up the real core after %s',
        async (reason) => {
            const { root, token, port, worker, closed } = await server()
            const rpc = new HelperRPC(join(root, 'helper.sock'), token)
            try {
                await rpc.request('tun.start', {
                    ...params(),
                    egressPort: await unusedPort(),
                    bridgePort: await unusedPort()
                })
                await expect
                    .poll(async () => {
                        try {
                            ;(await connect(port)).destroy()
                            return true
                        } catch {
                            return false
                        }
                    })
                    .toBe(true)
                if (reason === 'helper termination') worker.kill('SIGTERM')
                if (reason === 'helper SIGKILL') worker.kill('SIGKILL')
                await expect
                    .poll(
                        async () => {
                            try {
                                ;(await connect(port)).destroy()
                                return false
                            } catch {
                                return true
                            }
                        },
                        { timeout: 25000 }
                    )
                    .toBe(true)
            } finally {
                rpc.close()
                worker.kill('SIGTERM')
                await closed
            }
        },
        30000
    )
    it('rejects a paired token when the caller executable hash does not match', async () => {
        const { root, token, worker, closed } = await server()
        worker.kill('SIGTERM')
        await closed
        const pairing = JSON.parse(await readFile(join(root, 'pairing.json'), 'utf8'))
        pairing.caller.sha256 = '0'.repeat(64)
        await writeFile(join(root, 'pairing.json'), JSON.stringify(pairing))
        const restarted = cp.spawn(testHelper, [], {
            env: { ...process.env, FLUXY_HELPER_TEST_ROOT: root, FLUXY_HELPER_TEST_PORT: '18003' }
        })
        const stopped = once(restarted, 'close')
        const rpc = new HelperRPC(join(root, 'helper.sock'), token)
        try {
            await expect.poll(async () => (await readdir(root)).includes('helper.sock')).toBe(true)
            await expect(rpc.request('status')).rejects.toThrow('closed')
        } finally {
            rpc.close()
            restarted.kill('SIGTERM')
            await stopped
        }
    })
    it('reuses one installation across TUN, CA requests and app reconnection', async () => {
        const root = await mkdtemp(join(directory, 'reused-'))
        const client = join(root, 'client')
        await mkdir(client)
        const socket = join(root, 'helper.sock')
        const capturePort = await unusedPort()
        const originalSpawn = cp.spawn
        let worker: cp.ChildProcess | undefined
        let closed: Promise<unknown> | undefined
        let authorizations = 0
        const authorize = async () => {
            authorizations++
            const stage = (await readdir(client)).find((name) =>
                name.startsWith('helper-install-')
            )!
            const pairing = JSON.parse(await readFile(join(client, stage, 'pairing.json'), 'utf8'))
            pairing.caller.teamID = null
            await writeFile(join(root, 'pairing.json'), JSON.stringify(pairing))
            await symlink(core, join(root, 'sing-box'))
            worker = originalSpawn(testHelper, [], {
                env: {
                    ...process.env,
                    FLUXY_HELPER_TEST_ROOT: root,
                    FLUXY_HELPER_TEST_PORT: String(capturePort)
                }
            })
            closed = once(worker, 'close')
        }
        let helper = new HelperService(client, production, core, () => {}, socket, authorize)
        try {
            await expect(helper.ensureInstalled()).rejects.toThrow()
            expect(authorizations).toBe(0)
            await Promise.all([helper.install(), helper.install()])
            expect(helper.status.state).toBe('ready')
            expect(authorizations).toBe(1)
            for (let i = 0; i < 2; i++) {
                await helper.startTun({
                    ...params(),
                    egressPort: await unusedPort(),
                    bridgePort: await unusedPort()
                })
                await expect(helper.uninstall()).rejects.toThrow('Stop TUN before uninstalling')
                expect(authorizations).toBe(1)
                await helper.stopTun()
                const ca = new X509Certificate(
                    await readFile(await ensureCertificate(join(root, 'ca')))
                ).raw
                await expect(helper.installCertificate(ca)).rejects.toThrow(
                    'CA mutations are disabled'
                )
                await expect(helper.removeCertificate(ca)).rejects.toThrow(
                    'CA mutations are disabled'
                )
            }
            helper.close()
            helper = new HelperService(client, production, core, () => {}, socket, authorize)
            await helper.ensureInstalled()
            expect(helper.status.state).toBe('ready')
            expect(authorizations).toBe(1)
            const refresh = vi.spyOn(helper, 'refresh').mockImplementation(async () => {
                helper.status = { state: 'outdated' }
                return helper.status
            })
            await expect(helper.startTun(params())).rejects.toThrow(
                'Complete Helper & Certificate Setup'
            )
            expect(authorizations).toBe(1)
            refresh.mockRestore()
        } finally {
            helper.close()
            worker?.kill('SIGTERM')
            await closed
        }
    })
    it('pins copied executables, pairing and launchd plist in the authorized installer', async () => {
        const manifest = JSON.parse(await readFile(production + '.json', 'utf8'))
        const script = installationScript(
            "/tmp/quoted-'path",
            manifest,
            'a'.repeat(64),
            'b'.repeat(64)
        )
        expect(script).toContain(manifest.helperSHA256)
        expect(script).toContain(manifest.coreSHA256)
        expect(script).toContain('a'.repeat(64))
        expect(script).toContain('b'.repeat(64))
        // Syntax check only: never execute an installation in the test suite.
        await invoke('/bin/sh', ['-n'], script)
    })
})
