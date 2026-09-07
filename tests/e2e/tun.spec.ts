import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('TUN settings persist, authorization cancellation rolls back, and startup never silently elevates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-tun-desktop-'))
    await writeFile(
        join(directory, 'preferences.json'),
        JSON.stringify({
            settings: { onboardingCompleted: true, showWelcomeOnLaunch: false },
            rules: []
        })
    )
    const launch = () =>
        electron.launch({
            args: process.env.FLUXY_TEST_EXECUTABLE ? [] : ['.'],
            ...(process.env.FLUXY_TEST_EXECUTABLE
                ? { executablePath: process.env.FLUXY_TEST_EXECUTABLE }
                : {}),
            env: { ...process.env, FLUXY_DATA_DIR: directory }
        })
    let app = await launch()
    try {
        let page = await app.firstWindow()
        await expect(page.getByRole('heading', { name: 'Ready to capture traffic' })).toBeVisible()
        const before = await page.evaluate(() => window.fluxy.snapshot())
        expect(before.settings.captureMode).toBe('tun')
        expect(before.running).toBe(false)
        expect(before.tun.state).toBe('stopped')
        expect(before.tun.available).toBe(true)
        const exit = before.networkInterfaces.find((name) => !name.startsWith('utun'))!
        expect(exit).toBeTruthy()
        // Replace only the OS authorization launch; no privileged process or routes are created.
        await app.evaluate(() => {
            const cp = process.getBuiltinModule('node:child_process')!
            const original = cp.spawn
            cp.spawn = ((file: string, ...args: unknown[]) =>
                file === '/usr/bin/osascript' ||
                file === '/usr/bin/pkexec' ||
                (file === 'powershell.exe' && JSON.stringify(args).includes('-EncodedCommand'))
                    ? original(
                          process.execPath,
                          ['-e', 'process.stderr.write("Authorization canceled"); process.exit(1)'],
                          { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
                      )
                    : Reflect.apply(original, cp, [file, ...args])) as typeof cp.spawn
        })
        await page.getByRole('button', { name: 'Proxy status and connection setup' }).click()
        await expect(page.getByRole('combobox', { name: 'Capture mode' })).toHaveValue('tun')
        await expect(page.getByRole('button', { name: 'Start TUN', exact: true })).toBeEnabled()
        await page.getByRole('combobox', { name: 'TUN exit interface' }).selectOption(exit)
        await page.getByRole('textbox', { name: 'TUN route CIDRs' }).fill('203.0.113.123/32')
        await page.getByRole('button', { name: 'Start TUN', exact: true }).click()
        await expect(page.locator('.tun-settings').getByRole('alert').last()).toContainText(
            'Authorization canceled'
        )
        await expect(page.getByRole('button', { name: 'Start TUN', exact: true })).toBeEnabled()
        const after = await page.evaluate(() => window.fluxy.snapshot())
        expect(after.running).toBe(false)
        expect(after.systemProxy).toBe(false)
        expect(after.tun.state).toBe('error')
        expect(after.settings.tun.routeCIDRs).toEqual(['203.0.113.123/32'])
        expect(after.settings.upstream).toEqual(before.settings.upstream)
        await page.getByRole('combobox', { name: 'Capture mode' }).scrollIntoViewIfNeeded()
        await page.screenshot({ path: 'test-results/fluxy-tun-settings.png' })
        await page.evaluate(async () => {
            const s = await window.fluxy.snapshot()
            await window.fluxy.settings({ ...s.settings, autoStart: true })
        })
        await app.close()
        app = await launch()
        page = await app.firstWindow()
        await expect(page.getByRole('heading', { name: 'Ready to capture traffic' })).toBeVisible()
        const state = await page.evaluate(() => window.fluxy.snapshot())
        expect(state.settings.captureMode).toBe('tun')
        expect(state.settings.tun.routeCIDRs).toEqual(['203.0.113.123/32'])
        expect(state.tun.state).toBe('stopped')
        expect(state.running).toBe(false)
    } finally {
        await app.close()
        await rm(directory, { recursive: true, force: true })
    }
})
