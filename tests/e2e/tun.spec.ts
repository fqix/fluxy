import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('TUN capture domains persist and remain stopped when automatic startup is disabled', async () => {
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
        await page.getByRole('button', { name: 'Proxy status and connection setup' }).click()
        await expect(page.getByRole('combobox', { name: 'Capture mode' })).toHaveValue('tun')
        await expect(page.getByRole('button', { name: 'Start TUN', exact: true })).toBeEnabled()
        await page
            .getByRole('textbox', { name: 'TUN capture domains' })
            .fill('Example.com\n*.api.example.net')
        await page.getByRole('button', { name: 'Save TUN Settings', exact: true }).click()
        await expect
            .poll(
                async () =>
                    (await page.evaluate(() => window.fluxy.snapshot())).settings.tun.captureDomains
            )
            .toEqual(['example.com', 'api.example.net'])
        const after = await page.evaluate(() => window.fluxy.snapshot())
        expect(after.running).toBe(false)
        expect(after.systemProxy).toBe(false)
        expect(after.tun.state).toBe('stopped')
        expect(after.settings.tun.captureDomains).toEqual(['example.com', 'api.example.net'])
        expect(after.settings.upstream).toEqual(before.settings.upstream)
        await page.getByRole('combobox', { name: 'Capture mode' }).scrollIntoViewIfNeeded()
        await page.screenshot({ path: 'test-results/fluxy-tun-settings.png' })
        await app.close()
        app = await launch()
        page = await app.firstWindow()
        await expect(page.getByRole('heading', { name: 'Ready to capture traffic' })).toBeVisible()
        const state = await page.evaluate(() => window.fluxy.snapshot())
        expect(state.settings.captureMode).toBe('tun')
        expect(state.settings.tun.captureDomains).toEqual(['example.com', 'api.example.net'])
        expect(state.settings.autoStart).toBe(false)
        expect(state.tun.state).toBe('stopped')
        expect(state.running).toBe(false)
    } finally {
        await app.close()
        await rm(directory, { recursive: true, force: true })
    }
})
