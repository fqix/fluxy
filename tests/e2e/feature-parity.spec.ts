import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
async function menu(app: ElectronApplication, id: string) {
    await app.evaluate(({ Menu, BrowserWindow }, id) => {
        const item = Menu.getApplicationMenu()!.getMenuItemById(id)!
        item.click(undefined, BrowserWindow.getAllWindows()[0], undefined)
    }, id)
}
test('advanced rules persist, diff switches targets, and breakpoint queue retains edits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-feature-parity-'))
    const origin = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ path: req.url }))
    })
    origin.listen(0, '127.0.0.1')
    await once(origin, 'listening')
    const originPort = (origin.address() as AddressInfo).port
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
        const errors: string[] = []
        page.on('pageerror', (e) => errors.push(e.message))
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
        const port = await page.evaluate(async () => (await window.fluxy.snapshot()).settings.port)
        const request = (path: string) =>
            new Promise<number>((resolve, reject) => {
                const req = http.get(
                    {
                        host: '127.0.0.1',
                        port,
                        path: `http://127.0.0.1:${originPort}${path}`,
                        headers: { host: `127.0.0.1:${originPort}` }
                    },
                    (res) => {
                        res.resume()
                        res.on('end', () => resolve(res.statusCode!))
                    }
                )
                req.on('error', reject)
            })
        expect(await request('/alpha')).toBe(200)
        expect(await request('/beta')).toBe(200)
        await expect
            .poll(() =>
                page.evaluate(async () =>
                    (await window.fluxy.snapshot()).transactions.map((t) => t.state)
                )
            )
            .toEqual(['completed', 'completed'])
        const rows = page.locator('tr[data-request-id]')
        await expect(rows).toHaveCount(2)
        await page.getByRole('button', { name: 'Add Filter', exact: true }).click()
        await page.getByRole('button', { name: 'Add Condition', exact: true }).click()
        await page.getByLabel('Filter 1 field', { exact: true }).selectOption('path')
        await page.getByLabel('Filter 1 operator', { exact: true }).selectOption('is')
        await page.getByLabel('Filter 1 value', { exact: true }).fill('/alpha')
        await expect(rows).toHaveCount(1)
        await expect(rows.first()).toContainText('/alpha')
        await page.getByRole('button', { name: 'Add Condition', exact: true }).click()
        await page.getByLabel('Filter 2 connector', { exact: true }).selectOption('or')
        await page.getByLabel('Filter 2 value', { exact: true }).fill('/beta')
        await expect(rows).toHaveCount(2)
        await page.getByLabel('Enable filter 2', { exact: true }).uncheck()
        await expect(rows).toHaveCount(1)
        await page.getByRole('button', { name: 'Add Filter', exact: true }).click()
        await expect(rows).toHaveCount(2)
        await menu(app, 'Diff')
        const diff = page.getByRole('dialog', { name: 'Diff', exact: true })
        await diff
            .getByLabel('First request', { exact: true })
            .selectOption({ label: `GET http://127.0.0.1:${originPort}/alpha` })
        await diff
            .getByLabel('Second request', { exact: true })
            .selectOption({ label: `GET http://127.0.0.1:${originPort}/beta` })
        await expect(diff.locator('.diff-section')).toHaveCount(3)
        await expect(diff.locator('.diff-line.added').filter({ hasText: 'beta' })).toHaveCount(1)
        await page.getByLabel('Diff target').selectOption('Request')
        await expect(diff.locator('.diff-section')).toHaveCount(5)
        await page.getByLabel('Diff presentation').selectOption('Unified')
        await expect(diff.locator('.diff-lines.unified')).toHaveCount(5)
        await page.screenshot({ path: 'test-results/feature-parity-diff.png' })
        await page.getByLabel('Diff target').selectOption('Timing')
        await expect(diff).toContainText('Time to First Byte')
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
        await page.evaluate(async () => {
            await window.fluxy.rules([
                {
                    id: crypto.randomUUID(),
                    name: 'Pause queue',
                    enabled: true,
                    kind: 'breakpoint',
                    pattern: '*',
                    method: '*',
                    value: '',
                    header: '',
                    status: 200,
                    delay: 0,
                    phase: 'request',
                    uploadKbps: 0,
                    downloadKbps: 0
                }
            ])
        })
        const first = request('/first'),
            second = request('/second')
        const queue = page.getByRole('dialog', { name: 'Breakpoint Queue', exact: true })
        await expect(queue).toBeVisible()
        await expect(queue).toContainText('2 paused')
        const raw = page.getByLabel('Breakpoint HTTP message')
        const draft = (await raw.inputValue()).replace(/\n\n/, '\nX-Draft: retained\n\n')
        await raw.fill(draft)
        await page.getByRole('button', { name: 'Next', exact: true }).click()
        await expect(raw).not.toHaveValue(draft)
        await page.getByRole('button', { name: 'Previous', exact: true }).click()
        await expect(raw).toHaveValue(draft)
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
        await menu(app, 'Breakpoint Queue')
        await expect(raw).toHaveValue(draft)
        await page.screenshot({ path: 'test-results/feature-parity-breakpoints.png' })
        await page.getByRole('button', { name: 'Apply and Continue', exact: true }).click()
        await expect(queue).toContainText('1 paused')
        await raw.fill((await raw.inputValue()).replace(/\n\n/, '\nX-Batch: applied\n\n'))
        await page.getByRole('button', { name: 'Apply All and Continue', exact: true }).click()
        expect(await Promise.all([first, second])).toEqual([200, 200])
        await expect(queue).toContainText('No paused requests')
        const captured = await page.evaluate(
            async () => (await window.fluxy.snapshot()).transactions
        )
        expect(captured.some((t) => t.requestHeaders['x-draft'] === 'retained')).toBe(true)
        expect(captured.some((t) => t.requestHeaders['x-batch'] === 'applied')).toBe(true)
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
        await page.getByRole('button', { name: 'Add Filter', exact: true }).click()
        await expect
            .poll(async () =>
                page.evaluate(async () => {
                    const s = await window.fluxy.snapshot()
                    const tab = s.projects.projects.find((p) => p.id === s.projects.activeID)!
                        .tabs[0]
                    return tab.advanced ? tab.advancedRules[0]?.value : undefined
                })
            )
            .toBe('/alpha')
        expect(errors).toEqual([])
        await app.close()
        app = await launch()
        page = await app.firstWindow()
        await page
            .getByRole('dialog', { name: 'Welcome to Fluxy' })
            .getByRole('button', { name: 'Close', exact: true })
            .click()
        await expect(page.getByLabel('Filter 1 value', { exact: true })).toHaveValue('/alpha')
        await expect(page.getByLabel('Filter 2 connector', { exact: true })).toHaveValue('or')
        await expect(page.getByLabel('Enable filter 2', { exact: true })).not.toBeChecked()
    } finally {
        await app.close()
        origin.closeAllConnections()
        await new Promise<void>((resolve) => origin.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
    }
})
