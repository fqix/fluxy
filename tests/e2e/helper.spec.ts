import { createServer, type AddressInfo } from 'node:net'
import { once } from 'node:events'
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, symlink, readFile, access, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Electron reuses the helper, cancels removal safely, uninstalls and can install again', async () => {
    test.skip(
        process.platform !== 'darwin',
        'macOS audit-token fixture; other platform peers are covered by tools/helper tests'
    )
    test.setTimeout(90000)
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-helper-ui-'))
    const data = join(directory, 'data'),
        root = join(directory, 'server')
    await mkdir(root)
    const listener = createServer().listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const port = (listener.address() as AddressInfo).port
    await new Promise<void>((resolve) => listener.close(() => resolve()))
    await mkdir(data, { recursive: true })
    await writeFile(
        join(data, 'preferences.json'),
        JSON.stringify({ settings: { port }, rules: [] })
    )

    const binary = join(directory, 'helper-test')
    await promisify(execFile)(
        process.env.FLUXY_GO || 'go',
        ['build', '-tags=helper_testing', '-o', binary, '.'],
        { cwd: 'tools/helper', env: { ...process.env, CGO_ENABLED: '1' } }
    )
    await symlink(join(process.cwd(), 'build/electron-core/sing-box'), join(root, 'sing-box'))
    const launch = () =>
        electron.launch({
            args: process.env.FLUXY_TEST_EXECUTABLE ? [] : ['.'],
            ...(process.env.FLUXY_TEST_EXECUTABLE
                ? { executablePath: process.env.FLUXY_TEST_EXECUTABLE }
                : {}),
            env: { ...process.env, FLUXY_DATA_DIR: data }
        })
    const patch = (app: ElectronApplication) =>
        app.evaluate(
            (_electron, paths) => {
                const net = process.getBuiltinModule('node:net')!
                const originalConnect = net.createConnection
                net.createConnection = ((...args: unknown[]) => {
                    if (args[0] !== '/private/var/run/dev.fengqi.fluxy.electron.helper.sock')
                        return Reflect.apply(originalConnect, net, args)
                    args[0] = paths.root + '/helper.sock'
                    const socket = Reflect.apply(originalConnect, net, args)
                    const originalWrite = socket.write
                    socket.write = ((chunk: string | Buffer, ...rest: unknown[]) => {
                        const request = JSON.parse(chunk.toString())
                        if (request.method === 'ca.remove' && state.simulateCARemoval) {
                            // The real rootless helper must keep rejecting system CA mutations.
                            // Simulate only this boundary, validating the exact installation CA.
                            const { X509Certificate } = process.getBuiltinModule('node:crypto')!
                            const expected = new X509Certificate(
                                fs.readFileSync(paths.data + '/certificates/certs/ca.pem')
                            ).raw
                            const matches = expected.equals(Buffer.from(request.params, 'base64'))
                            state.caRemovalCount++
                            queueMicrotask(() =>
                                socket.emit(
                                    'data',
                                    Buffer.from(
                                        JSON.stringify({
                                            id: request.id,
                                            ...(matches
                                                ? {
                                                      result: {
                                                          buildID: 'fixture-ca-removal',
                                                          tunRunning: false
                                                      }
                                                  }
                                                : {
                                                      error: 'CA removal requested the wrong identity'
                                                  })
                                        }) + '\n'
                                    )
                                )
                            )
                            return true
                        }
                        return Reflect.apply(originalWrite, socket, [chunk, ...rest])
                    }) as typeof socket.write
                    return socket
                }) as typeof net.createConnection
                const cp = process.getBuiltinModule('node:child_process')!
                const fs = process.getBuiltinModule('node:fs')!
                const originalSpawn = cp.spawn
                const state = process as typeof process & {
                    helperAuthCount: number
                    testHelperPID?: number
                    uninstallConfirmed: boolean
                    uninstallAuthCanceled: boolean
                    simulateCARemoval: boolean
                    caRemovalCount: number
                }
                state.helperAuthCount = 0
                state.uninstallConfirmed = false
                state.uninstallAuthCanceled = false
                state.simulateCARemoval = false
                state.caRemovalCount = 0
                const originalDialog = _electron.dialog.showMessageBox
                _electron.dialog.showMessageBox = (async (...args: unknown[]) => {
                    const options = args.at(-1) as { message?: string }
                    if (options.message === 'Uninstall Fluxy Helper?')
                        return {
                            response: state.uninstallConfirmed ? 1 : 0,
                            checkboxChecked: false
                        }
                    return Reflect.apply(originalDialog, _electron.dialog, args)
                }) as typeof _electron.dialog.showMessageBox
                cp.spawn = ((file: string, ...args: unknown[]) => {
                    if ((args[0] as string[] | undefined)?.[0] !== 'authorize-desktop')
                        return Reflect.apply(originalSpawn, cp, [file, ...args])
                    state.helperAuthCount++
                    const { PassThrough } = process.getBuiltinModule('node:stream')!
                    const { EventEmitter } = process.getBuiltinModule('node:events')!
                    const worker = Object.assign(new EventEmitter(), {
                        stdin: new PassThrough(),
                        stdout: new PassThrough(),
                        stderr: new PassThrough()
                    })
                    let input = ''
                    worker.stdin.on('data', (chunk) => {
                        input += chunk.toString()
                    })
                    worker.stdin.on('finish', () => {
                        const request = JSON.parse(input) as { command: string }
                        if (request.command.includes('uninstall stopped')) {
                            if (state.uninstallAuthCanceled) {
                                worker.stderr.write('Uninstall authorization canceled')
                                setTimeout(() => worker.emit('close', 1), 10)
                                return
                            }
                            const pid = state.testHelperPID ?? paths.helperPID
                            if (pid) process.kill(pid, 'SIGTERM')
                            fs.rmSync(paths.root + '/pairing.json', { force: true })
                            setTimeout(() => worker.emit('close', 0), 1200)
                            return
                        }
                        const stage = fs
                            .readdirSync(paths.data)
                            .find((name) => name.startsWith('helper-install-'))!
                        fs.copyFileSync(
                            paths.data + '/' + stage + '/pairing.json',
                            paths.root + '/pairing.json'
                        )
                        const daemon = originalSpawn(paths.binary, [], {
                            env: {
                                ...process.env,
                                FLUXY_HELPER_TEST_ROOT: paths.root,
                                FLUXY_HELPER_TEST_PORT: '18003'
                            },
                            stdio: 'ignore'
                        })
                        state.testHelperPID = daemon.pid
                        setTimeout(() => worker.emit('close', 0), 300)
                    })
                    return worker
                }) as typeof cp.spawn
            },
            { root, data, binary, helperPID }
        )
    let app = await launch()
    let helperPID: number | undefined
    try {
        await patch(app)
        let page = await app.firstWindow()
        let welcome = page.getByRole('dialog', { name: 'Welcome to Fluxy' })
        await expect(welcome.getByRole('status')).toHaveText('0 of 2 complete')
        await welcome.getByRole('button', { name: 'Set Up', exact: true }).click()
        // Installing copies and verifies the bundled binaries before starting the helper.
        // Allow bounded startup time for the real signed application and helper.
        await expect(welcome.getByRole('status')).toHaveText('0 of 2 complete', {
            timeout: 20000
        })
        expect((await page.evaluate(() => window.fluxy.helperStatus())).state).toBe('ready')
        helperPID = await app.evaluate(
            () => (process as typeof process & { testHelperPID?: number }).testHelperPID
        )
        // The fixture installs only the rootless helper, never system trust.
        await expect(welcome.getByRole('alert')).toContainText(
            'certificate trust verification failed'
        )
        expect((await page.evaluate(() => window.fluxy.certificateStatus())).generated).toBe(true)
        for (let i = 0; i < 2; i++) {
            await expect(page.evaluate(() => window.fluxy.trustCertificate())).rejects.toThrow(
                'CA mutations are disabled'
            )
        }
        expect(
            await app.evaluate(
                () => (process as typeof process & { helperAuthCount: number }).helperAuthCount
            )
        ).toBe(1)
        await page.screenshot({ path: 'test-results/fluxy-helper-welcome.png' })
        await app.close()
        app = await launch()
        await patch(app)
        page = await app.firstWindow()
        expect((await page.evaluate(() => window.fluxy.helperStatus())).state).toBe('ready')
        await expect(
            page.getByRole('dialog', { name: 'Welcome to Fluxy' }).getByRole('status')
        ).toHaveText('0 of 2 complete')
        expect(
            await app.evaluate(
                () => (process as typeof process & { helperAuthCount: number }).helperAuthCount
            )
        ).toBe(0)
        const ca = await readFile(join(data, 'certificates/certs/ca.pem'), 'utf8')
        await page
            .getByRole('dialog', { name: 'Welcome to Fluxy' })
            .getByRole('button', { name: 'Close', exact: true })
            .click()
        await page.evaluate(async () => {
            const s = await window.fluxy.snapshot()
            await window.fluxy.settings({
                ...s.settings,
                captureMode: 'proxy',
                autoSystemProxy: false
            })
            await window.fluxy.start()
        })
        await expect
            .poll(() =>
                app.evaluate(
                    ({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('Helper Tool')!.enabled
                )
            )
            .toBe(true)
        await app.evaluate(({ Menu }) => {
            const menu = Menu.getApplicationMenu()!
            if (!menu.getMenuItemById('uninstall-helper'))
                throw new Error('Missing uninstall menu item')
            menu.getMenuItemById('Helper Tool')!.click()
        })
        const uninstall = page.getByRole('button', { name: 'Uninstall Helper', exact: true })
        await expect(uninstall).toBeEnabled()
        await uninstall.click() // App confirmation defaults to Cancel.
        expect((await page.evaluate(() => window.fluxy.snapshot())).running).toBe(true)
        expect(await app.evaluate(() => (process as any).helperAuthCount)).toBe(0)
        await app.evaluate(() => {
            ;(process as any).uninstallConfirmed = true
            ;(process as any).uninstallAuthCanceled = true
        })
        await uninstall.click()
        await expect(page.getByRole('alert').first()).toContainText('CA mutations are disabled')
        expect(await app.evaluate(() => (process as any).helperAuthCount)).toBe(0)
        await access(join(data, 'helper-client.json'))
        expect((await page.evaluate(() => window.fluxy.helperStatus())).state).toBe('ready')
        await app.evaluate(() => {
            ;(process as any).simulateCARemoval = true
        })
        await uninstall.click()
        await expect(page.getByRole('alert').first()).toContainText(
            'Uninstall authorization canceled'
        )
        expect(await app.evaluate(() => (process as any).caRemovalCount)).toBe(1)
        expect((await page.evaluate(() => window.fluxy.snapshot())).running).toBe(false)
        await access(join(data, 'helper-client.json'))
        expect((await page.evaluate(() => window.fluxy.helperStatus())).state).toBe('ready')
        await app.evaluate(() => {
            ;(process as any).uninstallAuthCanceled = false
        })
        await uninstall.click()
        await expect
            .poll(async () => (await page.evaluate(() => window.fluxy.snapshot())).helper.state)
            .toBe('missing')
        helperPID = undefined
        await expect(access(join(data, 'helper-client.json'))).rejects.toThrow()
        expect(await readFile(join(data, 'certificates/certs/ca.pem'), 'utf8')).toBe(ca)
        await expect(uninstall).toBeDisabled()
        expect(await app.evaluate(() => (process as any).helperAuthCount)).toBe(2)
        expect(await app.evaluate(() => (process as any).caRemovalCount)).toBe(2)
        await access(join(data, 'browser-ca-disabled'))
        await page.getByRole('button', { name: 'Set Up Helper & CA', exact: true }).click()
        await expect
            .poll(async () => (await page.evaluate(() => window.fluxy.snapshot())).helper.state, {
                timeout: 20000
            })
            .toBe('ready')
        helperPID = await app.evaluate(() => (process as any).testHelperPID)
        expect(await app.evaluate(() => (process as any).helperAuthCount)).toBe(3)
    } finally {
        if (!helperPID)
            helperPID = await app
                .evaluate(
                    () => (process as typeof process & { testHelperPID?: number }).testHelperPID
                )
                .catch(() => undefined)
        await app.close()
        if (helperPID) {
            try {
                process.kill(helperPID, 'SIGTERM')
            } catch {}
        }
        await rm(directory, { recursive: true, force: true })
    }
})
