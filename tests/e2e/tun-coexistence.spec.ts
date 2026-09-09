import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('detected Mihomo keeps TUN and never switches settings to SOCKS5', async () => {
    test.skip(
        !['darwin', 'win32'].includes(process.platform),
        'Scoped TUN requires macOS or Windows'
    )
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-coexistence-'))
    await writeFile(
        join(directory, 'preferences.json'),
        JSON.stringify({
            settings: {
                onboardingCompleted: true,
                showWelcomeOnLaunch: false,
                tun: { captureDomains: ['example.com'] }
            },
            rules: []
        })
    )
    const app = await electron.launch({
        args: process.env.FLUXY_TEST_EXECUTABLE ? [] : ['.'],
        ...(process.env.FLUXY_TEST_EXECUTABLE
            ? { executablePath: process.env.FLUXY_TEST_EXECUTABLE }
            : {}),
        env: { ...process.env, FLUXY_DATA_DIR: directory }
    })
    try {
        const page = await app.firstWindow()
        await expect(page.getByRole('heading', { name: 'Ready to capture traffic' })).toBeVisible()
        const before = await page.evaluate(() => window.fluxy.snapshot())
        await app.evaluate(({ dialog }) => {
            const state = globalThis as typeof globalThis & {
                coexistResponse: number
                coexistDialogs: string[]
            }
            state.coexistResponse = 1
            state.coexistDialogs = []
            dialog.showMessageBox = (async (
                _window: unknown,
                options: { message: string; detail: string; buttons: string[] }
            ) => {
                state.coexistDialogs.push(JSON.stringify(options))
                return { response: state.coexistResponse, checkboxChecked: false }
            }) as typeof dialog.showMessageBox
            const cp = process.getBuiltinModule('node:child_process')!
            const util = process.getBuiltinModule('node:util')!
            const original = cp.execFile
            const wrapped = ((
                file: string,
                args: string[],
                options: unknown,
                callback: Function
            ) => {
                const stdout =
                    file.endsWith('fluxy-helper.exe') && args[0] === 'proxy-processes'
                        ? JSON.stringify('123 verge-mihomo.exe\n')
                        : file.endsWith('fluxy-helper.exe') && args[0] === 'network-snapshot'
                          ? JSON.stringify({
                                routes: ['198.18.0.0/16', '0.0.0.0/1', '128.0.0.0/1'],
                                servers: ['192.0.2.53']
                            })
                          : file === 'ps'
                            ? '123 /Applications/Clash Verge.app/Contents/MacOS/verge-mihomo\n'
                            : file === '/usr/sbin/netstat'
                              ? '198.18/16 utun1024\n0/1 utun1024\n128.0/1 utun1024\n'
                              : undefined
                if (stdout !== undefined) {
                    queueMicrotask(() => callback(null, stdout, ''))
                    return {}
                }
                return Reflect.apply(original, cp, [file, args, options, callback])
            }) as typeof cp.execFile
            Object.defineProperty(wrapped, util.promisify.custom, {
                value: (file: string, args: string[], options: unknown) =>
                    new Promise((resolve, reject) =>
                        Reflect.apply(wrapped, cp, [
                            file,
                            args,
                            options,
                            (error: Error | null, stdout: string, stderr: string) =>
                                error ? reject(error) : resolve({ stdout, stderr })
                        ])
                    )
            })
            cp.execFile = wrapped
            process.getBuiltinModule('node:dns')!.getServers = () => ['192.0.2.53']
            // Fail before helper installation or TUN creation. Never change host routes/DNS.
            const fs = process.getBuiltinModule('node:fs/promises')!
            const read = fs.readFile
            fs.readFile = ((path: unknown, ...args: unknown[]) => {
                if (String(path) === '/etc/resolv.conf')
                    return Promise.resolve('nameserver 192.0.2.53\n')
                if (/fluxy-core(?:\.exe)?\.build\.json$/.test(String(path)))
                    return Promise.reject(
                        new Error('TUN startup intentionally stopped before elevation')
                    )
                return Reflect.apply(read, fs, [path, ...args])
            }) as typeof fs.readFile
        })
        await page.getByRole('button', { name: 'Proxy status and connection setup' }).click()
        await page.getByRole('button', { name: 'Start TUN', exact: true }).click()
        await expect
            .poll(() => app.evaluate(() => (globalThis as any).coexistDialogs.length))
            .toBe(1)
        const cancelled = await page.evaluate(() => window.fluxy.snapshot())
        expect(cancelled.tun.state).toBe('stopped')
        expect(cancelled.running).toBe(false)
        expect(cancelled.settings).toEqual(before.settings)
        await page
            .getByRole('textbox', { name: 'TUN capture domains' })
            .fill('Example.com\n*.api.example.net\nexample.com')
        await page.getByRole('button', { name: 'Save TUN Settings', exact: true }).click()
        await expect
            .poll(
                async () =>
                    (await page.evaluate(() => window.fluxy.snapshot())).settings.tun.captureDomains
            )
            .toEqual(['example.com', 'api.example.net'])
        const saved = await page.evaluate(() => window.fluxy.snapshot())
        expect(
            JSON.parse(await readFile(join(directory, 'preferences.json'), 'utf8')).settings.tun
                .captureDomains
        ).toEqual(['example.com', 'api.example.net'])
        await page.reload()
        await page.getByRole('button', { name: 'Proxy status and connection setup' }).click()
        await expect(page.getByRole('textbox', { name: 'TUN capture domains' })).toHaveValue(
            'example.com\napi.example.net'
        )
        await app.evaluate(() => {
            ;(globalThis as any).coexistResponse = 0
        })
        await page.getByRole('button', { name: 'Start TUN', exact: true }).click()
        await expect(page.locator('.tun-settings').getByRole('alert').last()).toContainText(
            'stopped before elevation'
        )
        const after = await page.evaluate(() => window.fluxy.snapshot())
        expect(after.settings.captureMode).toBe('tun')
        expect(after.settings.tun.socksPort).toBe(0)
        expect(after.settings).toEqual(saved.settings)
        expect(after.running).toBe(false)
        const dialogs = await app.evaluate(() => (globalThis as any).coexistDialogs as string[])
        expect(dialogs).toHaveLength(2)
        expect(dialogs[1]).toContain('Mihomo')
        expect(dialogs[1]).toContain('198.19.0.0/16')
        expect(dialogs[1]).toContain('Start TUN')
        expect(dialogs[1]).toContain('example.com, api.example.net')
    } finally {
        await app.close()
        await rm(directory, { recursive: true, force: true })
    }
})
