import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('shared controls retain keyboard focus and follow light, dark and system themes', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-ui-theme-'))
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
        const search = page.getByRole('textbox', { name: 'Search traffic' })
        for (const theme of ['light', 'dark', 'system'] as const) {
            await page.emulateMedia({ colorScheme: 'dark' })
            await page.evaluate(async (theme) => {
                const state = await window.fluxy.snapshot()
                await window.fluxy.settings({ ...state.settings, theme })
            }, theme)
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
            await expect(page.locator('body')).toHaveCSS(
                'background-color',
                theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(36, 36, 38)'
            )
            // Wait for control color transitions too; a dark background alone
            // can produce a screenshot with the previous theme's text colors.
            await expect(
                page.locator('.sidebar-tabs').getByRole('button', { name: 'Focus', exact: true })
            ).toHaveCSS('color', theme === 'light' ? 'rgb(32, 32, 36)' : 'rgb(230, 230, 233)')
            await search.fill('theme test')
            await expect(search).toHaveValue('theme test')
            await search.fill('')
            await page.keyboard.press('Tab')
            const filter = page
                .locator('.filter-tabs')
                .getByRole('button', { name: 'All', exact: true })
            await filter.focus()
            await expect(filter).toBeFocused()
            await expect
                .poll(() => filter.evaluate((element) => getComputedStyle(element).boxShadow))
                .not.toBe('none')
            await page.screenshot({ path: testInfo.outputPath(`ui-${theme}.png`) })
        }
    } finally {
        await app.close()
        await rm(directory, { recursive: true, force: true })
    }
})
