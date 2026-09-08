import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('selecting filtered requests reopens the request and response inspector', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-inspector-selection-'))
    await writeFile(
        join(directory, 'preferences.json'),
        JSON.stringify({
            settings: { onboardingCompleted: true, showWelcomeOnLaunch: false },
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
        await app.evaluate(({ dialog }, file) => {
            dialog.showMessageBox = (async () => ({
                response: 0,
                checkboxChecked: false
            })) as typeof dialog.showMessageBox
            dialog.showOpenDialog = (async () => ({
                canceled: false,
                filePaths: [file]
            })) as typeof dialog.showOpenDialog
        }, resolve('tests/fixtures/har/real-protocols.har'))
        await page.evaluate(() => window.fluxy.importHAR())
        const rows = page.locator('tr[data-request-id]')
        await rows.first().click()
        await expect(page.locator('.inspector')).toBeVisible()
        await page.getByTitle('Close inspector', { exact: true }).click()
        await page.locator('.nav-row').filter({ hasText: 'grpcb.in' }).click()
        const row = rows.filter({ hasText: '/DummyUnary' }).first()
        await row.click()
        await expect(row).toHaveClass(/selected/)
        await expect(page.locator('.inspector')).toBeVisible()
        await expect(page.locator('.inspector-pane')).toHaveCount(2)
        await expect(page.locator('.inspector .request-url')).toContainText('/DummyUnary')
        await page.getByTitle('Close inspector', { exact: true }).click()
        await row.click()
        await expect(page.locator('.inspector')).toBeVisible()
        await page.getByTitle('Toggle bottom inspector', { exact: true }).click()
        await page.locator('.traffic-table').focus()
        await page.keyboard.press('ArrowDown')
        await expect(page.locator('.inspector')).toBeVisible()
    } finally {
        await app.close()
        await rm(directory, { recursive: true, force: true })
    }
})
