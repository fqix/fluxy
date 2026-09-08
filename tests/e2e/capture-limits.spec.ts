import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('capture limits can be changed in Settings and persist across restart', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-capture-settings-'))
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
        const page = await app.firstWindow()
        await page
            .getByRole('dialog', { name: 'Welcome to Fluxy' })
            .getByRole('button', { name: 'Close', exact: true })
            .click()
        await page.getByTitle('Settings', { exact: true }).click()
        const requests = page.getByLabel('Maximum captured requests', { exact: true })
        const requestBody = page.getByLabel('Maximum request body (KiB)', { exact: true })
        const responseBody = page.getByLabel('Maximum response body (KiB)', { exact: true })
        await expect(requests).toHaveValue('10000')
        await expect(requests).toHaveAttribute('max', '10000')
        await expect(requestBody).toHaveValue('2048')
        await expect(responseBody).toHaveValue('2048')
        await requests.fill('1000')
        await requestBody.fill('64')
        await responseBody.fill('128')
        await page.getByRole('button', { name: 'Save Settings', exact: true }).click()
        await expect
            .poll(
                async () =>
                    (await page.evaluate(() => window.fluxy.snapshot())).settings
                        .maxRequestBodyBytes
            )
            .toBe(65536)
        await page.screenshot({ path: testInfo.outputPath('capture-limits.png') })
        await app.close()
        app = await launch()
        const restored = await app.firstWindow()
        const settings = await restored.evaluate(
            async () => (await window.fluxy.snapshot()).settings
        )
        expect(settings).toMatchObject({
            maxEntries: 1000,
            maxRequestBodyBytes: 65536,
            maxResponseBodyBytes: 131072
        })
        expect(
            JSON.parse(await readFile(join(directory, 'preferences.json'), 'utf8')).settings
        ).toMatchObject(settings)
    } finally {
        await app.close()
        await rm(directory, { recursive: true, force: true })
    }
})
