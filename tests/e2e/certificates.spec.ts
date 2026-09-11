import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureCertificate } from '../../src/main/certificates/certificates'

test('removes legacy system trust and reinstalls the same certificate with visible feedback', async () => {
    test.skip(process.platform !== 'darwin', 'macOS certificate migration')
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-certificate-ui-'))
    const path = await ensureCertificate(join(directory, 'certificates'))
    const certificate = await readFile(path, 'utf8')
    const app = await electron.launch({
        args: process.env.FLUXY_TEST_EXECUTABLE ? [] : ['.'],
        ...(process.env.FLUXY_TEST_EXECUTABLE
            ? { executablePath: process.env.FLUXY_TEST_EXECUTABLE }
            : {}),
        env: { ...process.env, FLUXY_DATA_DIR: directory }
    })
    try {
        const page = await app.firstWindow()
        await page
            .getByRole('dialog', { name: 'Welcome to Fluxy' })
            .getByRole('button', { name: 'Close', exact: true })
            .click()
        // Simulate only the OS boundary. No certificate or authorization command
        // in this test is allowed to reach the real keychain.
        await app.evaluate(({ dialog }) => {
            const cp = process.getBuiltinModule('node:child_process')!
            const originalSpawn = cp.spawn
            const originalExecFile = cp.execFile
            const state = { trusted: true, actions: [] as string[], confirmed: true }
            Object.assign(globalThis, { certificateFixture: state })
            dialog.showMessageBox = async () => ({
                response: state.confirmed ? 1 : 0,
                checkboxChecked: false
            })
            cp.spawn = ((file: string, args: string[], options: object) => {
                if (!/fluxy-helper(?:\.exe)?$/.test(file)) return originalSpawn(file, args, options)
                const action = args[0]
                state.actions.push(action)
                if (action === 'authorize-desktop') state.trusted = false
                else if (action === 'trust-ca-desktop') state.trusted = true
                else if (action !== 'untrust-ca-desktop')
                    throw new Error(`Unexpected helper action: ${action}`)
                return originalSpawn(
                    process.execPath,
                    [
                        '-e',
                        'process.stdin.resume(); process.stdin.on("end", () => { console.log(process.argv[1]); process.exit(0) })',
                        JSON.stringify({ adminTrust: action === 'untrust-ca-desktop' })
                    ],
                    { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
                )
            }) as typeof cp.spawn
            cp.execFile = ((file: string, args: string[], options: object, callback: unknown) => {
                if (file !== '/usr/bin/security')
                    return Reflect.apply(originalExecFile, cp, [file, args, options, callback])
                if (args[0] !== 'verify-cert') throw new Error('Unexpected keychain command')
                return Reflect.apply(originalExecFile, cp, [
                    process.execPath,
                    ['-e', state.trusted ? '' : 'console.error("not trusted"); process.exit(1)'],
                    { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
                    callback
                ])
            }) as typeof cp.execFile
            Object.defineProperty(cp.execFile, Symbol.for('nodejs.util.promisify.custom'), {
                value: (file: string, args: string[], options: object) =>
                    new Promise((resolve, reject) => {
                        cp.execFile(file, args, options, (error, stdout, stderr) => {
                            if (error) reject(Object.assign(error, { stdout, stderr }))
                            else resolve({ stdout, stderr })
                        })
                    })
            })
        })
        expect(await page.evaluate(() => window.fluxy.uninstallCertificate())).toBe(true)
        const actions = () =>
            app.evaluate(
                () =>
                    (globalThis as unknown as { certificateFixture: { actions: string[] } })
                        .certificateFixture.actions
            )
        expect(await actions()).toEqual(['untrust-ca-desktop', 'authorize-desktop'])
        expect((await page.evaluate(() => window.fluxy.certificateStatus())).trusted).toBe(false)
        expect(await readFile(path, 'utf8')).toBe(certificate)

        await app.evaluate(({ Menu, BrowserWindow }) => {
            Menu.getApplicationMenu()!
                .getMenuItemById('Certificates')!
                .click(undefined as never, BrowserWindow.getAllWindows()[0], {} as never)
        })
        const panel = page.getByRole('dialog', { name: 'Certificates', exact: true })
        await expect(panel).toBeVisible()
        await expect(panel).toContainText('Not trusted')
        await panel.getByRole('button', { name: 'Install & Trust', exact: true }).click()
        await expect(panel.getByRole('status')).toHaveText('Certificate installed and trusted.')
        expect(await actions()).toEqual([
            'untrust-ca-desktop',
            'authorize-desktop',
            'trust-ca-desktop'
        ])
        expect(await readFile(path, 'utf8')).toBe(certificate)

        // An already trusted CA still produces feedback without another prompt.
        await panel.screenshot({ path: test.info().outputPath('certificate-panel.png') })
        await panel.getByRole('button', { name: 'Install & Trust', exact: true }).click()
        await expect(panel.getByRole('status')).toHaveText('Certificate installed and trusted.')
        expect(await actions()).toHaveLength(3)
        await app.evaluate(() => {
            ;(
                globalThis as unknown as { certificateFixture: { confirmed: boolean } }
            ).certificateFixture.confirmed = false
        })
        await panel.getByRole('button', { name: 'Uninstall Certificate', exact: true }).click()
        await expect(panel.getByRole('status')).toHaveText('Certificate removal canceled.')
        expect(await actions()).toHaveLength(3)
        expect((await page.evaluate(() => window.fluxy.certificateStatus())).trusted).toBe(true)

        // Keep authorization pending until the test releases it, so progress and
        // duplicate-click protection are checked without timing assumptions.
        await app.evaluate(({ ipcMain }) => {
            ipcMain.removeHandler('fluxy:certificate:trust')
            ipcMain.handle(
                'fluxy:certificate:trust',
                () =>
                    new Promise((_resolve, reject) => {
                        Object.assign(globalThis, {
                            cancelCertificateInstall: () =>
                                reject(new Error('Authorization canceled'))
                        })
                    })
            )
        })
        await panel.getByRole('button', { name: 'Install & Trust', exact: true }).click()
        await expect(panel.getByRole('status')).toContainText('Installing certificate…')
        await expect(
            panel.getByRole('button', { name: 'Install & Trust', exact: true })
        ).toBeDisabled()
        await expect(
            panel.getByRole('button', { name: 'Uninstall Certificate', exact: true })
        ).toBeDisabled()
        await app.evaluate(() => {
            ;(
                globalThis as unknown as { cancelCertificateInstall: () => void }
            ).cancelCertificateInstall()
        })
        await expect(panel.getByRole('alert')).toHaveText('Authorization canceled')
        await expect(
            panel.getByRole('button', { name: 'Install & Trust', exact: true })
        ).toBeEnabled()
    } finally {
        await app.close()
        await rm(directory, { recursive: true, force: true })
    }
})
