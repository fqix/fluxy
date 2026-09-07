import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsSchema } from '../../src/shared/contracts/model'
async function menu(app: ElectronApplication, id: string) {
    await expect
        .poll(() =>
            app.evaluate(({ Menu, BrowserWindow }, id) => {
                const item = Menu.getApplicationMenu()!.getMenuItemById(id)!
                if (!item.enabled) return false
                item.click(undefined, BrowserWindow.getAllWindows()[0], undefined)
                return true
            }, id)
        )
        .toBe(true)
}
test('removes AI, configures updates and network presets, persists and exports text comparisons', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-completion-'))
    await writeFile(join(directory, 'assistant-key.json'), '{"encrypted":"retired"}')
    await writeFile(
        join(directory, 'preferences.json'),
        JSON.stringify({
            settings: {
                ...settingsSchema.parse({}),
                assistant: {
                    enabled: true,
                    kind: 'ollama',
                    endpoint: 'http://127.0.0.1:9',
                    model: 'old'
                }
            },
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
        await page
            .getByRole('dialog', { name: 'Welcome to Fluxy' })
            .getByRole('button', { name: 'Close', exact: true })
            .click()
        expect(
            await page.evaluate(async () => ({
                api: 'assistantAsk' in window.fluxy,
                settings: 'assistant' in (await window.fluxy.snapshot()).settings
            }))
        ).toEqual({ api: false, settings: false })
        await expect(readFile(join(directory, 'assistant-key.json'))).rejects.toThrow()
        expect(
            JSON.parse(await readFile(join(directory, 'preferences.json'), 'utf8')).settings
                .assistant
        ).toBeUndefined()
        await menu(app, 'check-updates')
        await expect(page.getByRole('dialog', { name: 'Updates' })).toContainText('Fluxy Updates')
        await page.getByLabel('Automatically check for updates').uncheck()
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
        await menu(app, 'Network Conditions')
        await page.getByLabel('Network condition name').fill('Mobile test')
        await page.getByLabel('Network condition preset').selectOption('edge')
        await expect(page.getByLabel('Network delay')).toHaveValue('850')
        await expect(page.getByLabel('Network uploadKbps')).toHaveValue('200')
        await page.getByLabel('Enable network condition').check()
        await page.getByRole('button', { name: 'Save Network Condition' }).click()
        await expect(page.getByRole('status')).toContainText('Network condition saved')
        await page.getByRole('button', { name: 'Add Rule', exact: true }).click()
        await page.getByLabel('Network condition name').fill('Custom test')
        await page.getByLabel('Network condition preset').selectOption('custom')
        await page.getByLabel('Network delay').fill('150')
        await page.getByLabel('Network downloadKbps').fill('256')
        await page.getByLabel('Enable network condition').check()
        await page.getByRole('button', { name: 'Save Network Condition' }).click()
        await expect
            .poll(() =>
                page.evaluate(async () =>
                    (await window.fluxy.snapshot()).rules
                        .filter((r) => r.kind === 'networkCondition' && r.enabled)
                        .map((r) => r.name)
                )
            )
            .toEqual(['Custom test'])
        await page.screenshot({ path: 'test-results/fluxy-network-conditions.png' })
        await page.getByRole('button', { name: 'Disable All' }).click()
        await expect
            .poll(() =>
                page.evaluate(
                    async () =>
                        (await window.fluxy.snapshot()).rules.filter(
                            (r) => r.kind === 'networkCondition' && r.enabled
                        ).length
                )
            )
            .toBe(0)
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
        await menu(app, 'Diff')
        await page.getByLabel('Diff source').selectOption('Text')
        await page.getByLabel('Diff Side A').fill('one\nold\nthree')
        await page.getByLabel('Diff Side B').fill('one\nnew\nthree')
        await expect(page.getByRole('dialog', { name: 'Diff' }).getByRole('status')).toContainText(
            '1 added · 1 removed'
        )
        const exportPath = join(directory, 'text.diff')
        await app.evaluate(({ dialog }, filePath) => {
            dialog.showSaveDialog = async () => ({ canceled: false, filePath })
        }, exportPath)
        await page.getByRole('button', { name: 'Export Diff', exact: true }).click()
        await expect
            .poll(async () => {
                try {
                    return await readFile(exportPath, 'utf8')
                } catch {
                    return ''
                }
            })
            .toContain('-old\n+new')
        await page.getByRole('button', { name: 'Next Difference', exact: true }).click()
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
        await app.close()
        app = await launch()
        page = await app.firstWindow()
        await page
            .getByRole('dialog', { name: 'Welcome to Fluxy' })
            .getByRole('button', { name: 'Close', exact: true })
            .click()
        const saved = await page.evaluate(() => window.fluxy.snapshot())
        expect(saved.settings.updates.checkAutomatically).toBe(false)
        expect(saved.rules.filter((r) => r.kind === 'networkCondition')).toHaveLength(2)
        expect(saved.rules.find((r) => r.name === 'Custom test')?.downloadKbps).toBe(256)
    } finally {
        await app.close()
        await rm(directory, { recursive: true, force: true })
    }
})

test('saved Diff pairs survive clearing traffic and restarting Electron', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-diff-desktop-'))
    const { createServer } = await import('node:http')
    const origin = createServer((request, response) =>
        response.end(request.url === '/a' ? 'old value' : 'new value')
    )
    origin.listen(0, '127.0.0.1')
    await once(origin, 'listening')
    const port = (origin.address() as import('node:net').AddressInfo).port
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
        await page
            .getByRole('dialog', { name: 'Welcome to Fluxy' })
            .getByRole('button', { name: 'Close', exact: true })
            .click()
        const requests = await page.evaluate(async (port) => {
            const ids: string[] = []
            for (const path of ['/a', '/b'])
                ids.push(
                    (
                        await window.fluxy.compose({
                            url: `http://127.0.0.1:${port}${path}`,
                            method: 'GET',
                            headers: {},
                            body: ''
                        })
                    ).id
                )
            return ids
        }, port)
        await menu(app, 'Diff')
        await page.getByLabel('Diff source').selectOption('Captured requests')
        await page.getByLabel('First request').selectOption(requests[0])
        await page.getByLabel('Second request').selectOption(requests[1])
        await expect(
            page.getByRole('button', { name: 'Pin comparison GET /a ↔ GET /b' })
        ).toBeVisible()
        await page.getByRole('button', { name: 'Pin comparison GET /a ↔ GET /b' }).click()
        await expect(
            page.getByRole('button', { name: '★ GET /a ↔ GET /b', exact: true })
        ).toBeVisible()
        await page.evaluate(() => window.fluxy.clear())
        await page.getByRole('button', { name: '★ GET /a ↔ GET /b', exact: true }).click()
        await expect(page.getByRole('dialog', { name: 'Diff' })).toContainText('old value')
        await app.close()
        app = await launch()
        page = await app.firstWindow()
        await page
            .getByRole('dialog', { name: 'Welcome to Fluxy' })
            .getByRole('button', { name: 'Close', exact: true })
            .click()
        await menu(app, 'Diff')
        await page.getByRole('button', { name: '★ GET /a ↔ GET /b', exact: true }).click()
        await expect(page.getByRole('dialog', { name: 'Diff' })).toContainText('new value')
        expect(await page.evaluate(() => window.fluxy.diffHistory())).toHaveLength(1)
        await page.screenshot({ path: 'test-results/fluxy-diff-workspace.png' })
    } finally {
        await app.close()
        origin.closeAllConnections()
        await new Promise<void>((resolve) => origin.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
    }
})
