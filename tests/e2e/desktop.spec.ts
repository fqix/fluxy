import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import net from 'node:net'
import type { FluxyAPI } from '../../src/shared/contracts/model'
test('desktop captures real traffic, filters, inspects, persists and composes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-desktop-'))
    const origin = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ message: 'Hello from Fluxy', path: req.url, ok: true }))
    })
    origin.listen(0, '127.0.0.1')
    await once(origin, 'listening')
    const originPort = (origin.address() as net.AddressInfo).port
    const app = await electron.launch({
        args: process.env.FLUXY_TEST_EXECUTABLE ? [] : ['.'],
        ...(process.env.FLUXY_TEST_EXECUTABLE
            ? { executablePath: process.env.FLUXY_TEST_EXECUTABLE }
            : {}),
        env: { ...process.env, FLUXY_DATA_DIR: directory },
        timeout: 30000
    })
    try {
        const page = await app.firstWindow()
        const errors: string[] = []
        page.on('pageerror', (e) => errors.push(e.message))
        await expect(page.getByRole('dialog', { name: 'Welcome to Fluxy' })).toBeVisible()
        await page.getByRole('button', { name: 'Close', exact: true }).click()
        await expect(page.getByRole('heading', { name: 'Ready to capture traffic' })).toBeVisible()
        // Check the actual sandbox boundary rather than simply asserting config constants.
        expect(
            await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)
        ).toBe('undefined')
        expect(await page.evaluate(() => typeof window.fluxy.snapshot)).toBe('function')
        // This case exercises HTTP proxy capture; TUN is covered separately.
        await page.evaluate(async () => {
            const state = await window.fluxy.snapshot()
            await window.fluxy.settings({
                ...state.settings,
                captureMode: 'proxy',
                autoSystemProxy: false
            })
        })
        await page.getByRole('button', { name: 'Start Capture', exact: true }).click()
        await expect(page.getByRole('heading', { name: 'Listening for traffic' })).toBeVisible()
        const state = await page.evaluate(() => window.fluxy.snapshot())
        await new Promise<void>((resolve, reject) => {
            const req = http.get(
                {
                    host: '127.0.0.1',
                    port: state.settings.port,
                    path: `http://127.0.0.1:${originPort}/api/users`,
                    headers: { host: `127.0.0.1:${originPort}`, 'user-agent': 'curl/8.0' }
                },
                (res) => {
                    res.resume()
                    res.on('end', resolve)
                }
            )
            req.on('error', reject)
        })
        const row = page.locator('tr[data-request-id]').first()
        await expect(row).toContainText('/api/users')
        await row.click()
        await expect(page.locator('.inspector')).toBeVisible()
        await page
            .locator('.inspector-pane')
            .nth(1)
            .getByRole('button', { name: 'Body', exact: true })
            .click()
        await expect(page.locator('.inspector-pane').nth(1)).toContainText('Hello from Fluxy')
        await page.getByRole('textbox', { name: 'Search traffic' }).fill('does-not-exist')
        await expect(page.getByRole('heading', { name: 'No matching requests' })).toBeVisible()
        await page.getByRole('textbox', { name: 'Search traffic' }).fill('')
        await expect(row).toBeVisible()
        await page.getByRole('button', { name: 'Pin request', exact: true }).click()
        await page.getByRole('button', { name: 'Library', exact: true }).click()
        await expect(page.getByRole('button', { name: /Pinned/ })).toContainText('1')
        await page.getByRole('button', { name: 'Save Current Session', exact: true }).click()
        await page.getByRole('textbox', { name: 'Session name' }).fill('Desktop regression')
        await page
            .getByRole('dialog')
            .getByRole('button', { name: 'Save Session', exact: true })
            .click()
        await expect(page.getByRole('button', { name: /Desktop regression/ })).toBeVisible()
        await page.getByRole('button', { name: 'Compose request', exact: true }).click()
        await page
            .getByRole('textbox', { name: 'Request URL' })
            .fill(`http://127.0.0.1:${originPort}/composed`)
        await page.getByRole('button', { name: 'Send', exact: true }).click()
        await expect(page.locator('.compose-response')).toContainText('/composed')
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
        await page.getByRole('button', { name: 'Block List', exact: true }).click()
        await page.getByRole('button', { name: 'Add Rule', exact: true }).first().click()
        await page
            .getByLabel('URL pattern', { exact: true })
            .fill(`http://127.0.0.1:${originPort}/blocked*`)
        await page.getByRole('button', { name: 'Save Rules', exact: true }).click()
        await expect(page.getByRole('status')).toContainText('Rules saved')
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
        await page.getByRole('button', { name: 'Browse', exact: true }).click()
        await page.getByRole('button', { name: 'Toggle context dock', exact: true }).click()
        await expect(page.getByRole('button', { name: 'AI Assistant', exact: true })).toHaveCount(0)
        expect(await page.evaluate(() => 'assistantAsk' in window.fluxy)).toBe(false)
        await mkdir('test-results', { recursive: true })
        await page.screenshot({ path: 'test-results/fluxy-desktop-light.png' })
        await page.evaluate(async () => {
            const s = await window.fluxy.snapshot()
            await window.fluxy.settings({ ...s.settings, theme: 'dark' })
        })
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
        await page.screenshot({ path: 'test-results/fluxy-desktop-dark.png' })
        await page.evaluate(async () => {
            await window.fluxy.scripts([
                {
                    id: crypto.randomUUID(),
                    name: 'Header test',
                    enabled: true,
                    pattern: '*/scripted',
                    phase: 'request',
                    code: "request.headers['x-script'] = 'active'; return request;"
                },
                {
                    id: crypto.randomUUID(),
                    name: 'Body test',
                    enabled: true,
                    pattern: '*/scripted',
                    phase: 'response',
                    code: 'response.body = JSON.stringify({sandbox: typeof process, node: typeof require, scripted: true}); return response;'
                }
            ])
        })
        const scripted = await new Promise<string>((resolve, reject) => {
            const req = http.get(
                {
                    host: '127.0.0.1',
                    port: state.settings.port,
                    path: `http://127.0.0.1:${originPort}/scripted`,
                    headers: { host: `127.0.0.1:${originPort}` }
                },
                (res) => {
                    const chunks: Buffer[] = []
                    res.on('data', (b) => chunks.push(b))
                    res.on('end', () => resolve(Buffer.concat(chunks).toString()))
                }
            )
            req.on('error', reject)
        })
        expect(JSON.parse(scripted)).toEqual({
            sandbox: 'undefined',
            node: 'undefined',
            scripted: true
        })
        const scriptState = await page.evaluate(() => window.fluxy.snapshot())
        expect(
            scriptState.transactions.find((t) => t.path === '/scripted')?.requestHeaders['x-script']
        ).toBe('active')
        const saved = JSON.parse(await readFile(join(directory, 'preferences.json'), 'utf8'))
        expect(saved.rules).toHaveLength(1)
        expect(errors).toEqual([])
        await page.getByRole('button', { name: 'Stop proxy', exact: true }).click()
        await expect(page.locator('.proxy-pill')).toContainText('Stopped')
    } finally {
        await app.close()
        origin.closeAllConnections()
        await new Promise<void>((r) => origin.close(() => r()))
        await rm(directory, { recursive: true, force: true })
    }
})
