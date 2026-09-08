import {
    test,
    expect,
    _electron as electron,
    type ElectronApplication,
    type Page
} from '@playwright/test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { initialMenuState } from '../../src/shared/app/menu'

async function workspaceState(page: Page) {
    return page.evaluate(async () => {
        const { projects } = await window.fluxy.snapshot()
        const project = projects.projects.find((p) => p.id === projects.activeID)!
        return { count: project.tabs.length }
    })
}
async function state(app: ElectronApplication, id: string) {
    return app.evaluate(({ Menu }, id) => {
        const item = Menu.getApplicationMenu()!.getMenuItemById(id)!
        return { enabled: item.enabled, checked: item.checked, label: item.label }
    }, id)
}
async function click(app: ElectronApplication, id: string) {
    // A real menu cannot activate a disabled item. Check and activate atomically,
    // rather than allowing an asynchronous state refresh between two RPCs.
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
test('menu state updates survive normalized separators and keep duplicate commands scoped', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-menu-sync-'))
    const app = await electron.launch({
        args: process.env.FLUXY_TEST_EXECUTABLE ? [] : ['.'],
        ...(process.env.FLUXY_TEST_EXECUTABLE
            ? { executablePath: process.env.FLUXY_TEST_EXECUTABLE }
            : {}),
        env: { ...process.env, FLUXY_DATA_DIR: directory }
    })
    try {
        const page = await app.firstWindow()
        await expect(page.getByRole('dialog', { name: 'Welcome to Fluxy' })).toBeVisible()
        await page.evaluate(async (initial) => {
            const state = { ...initial, ready: true, hasTraffic: true }
            // The empty Project submenu ends in a separator removed by Electron.
            await window.fluxy.menuState(state)
            await window.fluxy.menuState({ ...state, sidebar: false, theme: 'dark' })
        }, initialMenuState)
        expect((await state(app, 'sidebar')).checked).toBe(false)
        expect((await state(app, 'theme-dark')).checked).toBe(true)
        const exports = await app.evaluate(({ Menu }) => {
            const menu = Menu.getApplicationMenu()!
            const file = menu.items.find((item) => item.label === 'File')!.submenu!
            const flow = menu.items.find((item) => item.label === 'Flow')!.submenu!
            return {
                allTraffic: file.getMenuItemById('openapi-yaml')!.enabled,
                selection: flow.getMenuItemById('openapi-yaml')!.enabled
            }
        })
        expect(exports).toEqual({ allTraffic: true, selection: false })
        await page.evaluate(async (initial) => {
            await window.fluxy.menuState({ ...initial, ready: true, busy: true })
        }, initialMenuState)
        expect((await state(app, 'sidebar')).enabled).toBe(false)
        expect((await state(app, 'openapi-yaml')).enabled).toBe(false)
    } finally {
        await app.close()
        await rm(directory, { recursive: true, force: true })
    }
})
test('native menu controls workspaces, views, traffic, selection and dialogs', async () => {
    test.setTimeout(90000)
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-menu-'))
    let requests = 0
    const server = http
        .createServer((_req, res) => {
            requests++
            res.end('menu response')
        })
        .listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/menu`
    const app = await electron.launch({
        args: process.env.FLUXY_TEST_EXECUTABLE ? [] : ['.'],
        ...(process.env.FLUXY_TEST_EXECUTABLE
            ? { executablePath: process.env.FLUXY_TEST_EXECUTABLE }
            : {}),
        env: { ...process.env, FLUXY_DATA_DIR: directory }
    })
    try {
        const page = await app.firstWindow()
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await expect(page.getByRole('dialog', { name: 'Welcome to Fluxy' })).toBeVisible()
        expect((await state(app, 'new-workspace')).enabled).toBe(false)
        await page.getByRole('button', { name: 'Close', exact: true }).click()
        await expect.poll(async () => (await state(app, 'new-workspace')).enabled).toBe(true)
        expect((await state(app, 'copy-url')).enabled).toBe(false)
        expect((await state(app, 'compare')).enabled).toBe(false)
        expect((await state(app, 'close-workspace')).enabled).toBe(false)
        await click(app, 'new-workspace')
        await expect.poll(async () => (await workspaceState(page)).count).toBe(2)
        await click(app, 'rename-workspace')
        await page.getByLabel('Workspace name').fill('Menu workspace')
        await page.getByRole('button', { name: 'Rename', exact: true }).click()
        await expect(page.locator('.workspace-title')).toContainText('Menu workspace')
        await click(app, 'previous-workspace')
        await expect(page.locator('.workspace-title')).toContainText('All Traffic')
        await click(app, 'next-workspace')
        await expect(page.locator('.workspace-title')).toContainText('Menu workspace')
        await click(app, 'close-workspace')
        await expect.poll(async () => (await workspaceState(page)).count).toBe(1)
        await click(app, 'sidebar')
        await expect(page.locator('.sidebar')).toHaveCount(0)
        await expect.poll(async () => (await state(app, 'sidebar')).checked).toBe(false)
        await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click()
        await expect.poll(async () => (await state(app, 'sidebar')).checked).toBe(true)
        await click(app, 'find')
        await expect(page.getByRole('textbox', { name: 'Search traffic' })).toBeFocused()
        await click(app, 'theme-dark')
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
        await expect.poll(async () => (await state(app, 'theme-dark')).checked).toBe(true)
        await click(app, 'no-cache')
        await expect.poll(async () => (await state(app, 'no-cache')).checked).toBe(true)
        await click(app, 'Help')
        await expect(page.getByRole('dialog', { name: 'Help', exact: true })).toContainText(
            'Inspect traffic with Fluxy'
        )
        await expect.poll(async () => (await state(app, 'clear-filters')).enabled).toBe(false)
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
        await click(app, 'sessions')
        await expect(page.getByRole('dialog')).toContainText('No saved sessions yet')
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
        await page.evaluate(async (url) => {
            await window.fluxy.compose({ method: 'GET', url, headers: {}, body: '' })
        }, url)
        await expect(page.locator('tr[data-request-id]')).toHaveCount(1)
        await click(app, 'last-request')
        await expect.poll(async () => (await state(app, 'copy-url')).enabled).toBe(true)
        await click(app, 'copy-url')
        await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(url)
        await click(app, 'copy-curl')
        await expect
            .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
            .toContain(url)
        await click(app, 'pin')
        await expect.poll(async () => (await state(app, 'pin')).checked).toBe(true)
        await click(app, 'highlight:purple')
        await expect(page.locator('tr[data-request-id]').first()).toHaveAttribute(
            'data-highlight',
            'purple'
        )
        await click(app, 'note')
        await page.getByLabel('Request note').fill('Menu note saved')
        await page.getByRole('button', { name: 'Save Note', exact: true }).click()
        await expect
            .poll(() =>
                page.evaluate(async () => (await window.fluxy.snapshot()).transactions[0].note)
            )
            .toBe('Menu note saved')
        const exportPath = join(directory, 'menu-api.yaml')
        await app.evaluate(({ dialog }, filePath) => {
            dialog.showSaveDialog = async () => ({ canceled: false, filePath })
        }, exportPath)
        await click(app, 'openapi-yaml')
        await expect
            .poll(async () => {
                try {
                    return await readFile(exportPath, 'utf8')
                } catch {
                    return ''
                }
            })
            .toContain('"openapi": "3.0.3"')
        await click(app, 'repeat')
        await expect(page.locator('tr[data-request-id]')).toHaveCount(2)
        expect(requests).toBe(2)
        await page.locator('tr[data-request-id]').first().click()
        await page
            .locator('tr[data-request-id]')
            .last()
            .click({ modifiers: ['Shift'] })
        await click(app, 'compare')
        await expect(
            page.getByRole('dialog', { name: 'Compare Requests' }).locator('.diff-section')
        ).toHaveCount(3)
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
        await click(app, 'Save Session')
        await page.getByLabel('Session name').fill('Menu session')
        await page.getByRole('button', { name: 'Save Session', exact: true }).click()
        await click(app, 'sessions')
        await page.getByRole('button', { name: 'Menu session · 2 requests' }).click()
        await page.getByRole('button', { name: 'Open Session', exact: true }).click()
        await expect(page.locator('tr[data-request-id]')).toHaveCount(2)
        await page.getByRole('textbox', { name: 'Search traffic' }).fill('missing')
        await click(app, 'clear-filters')
        await expect(page.getByRole('textbox', { name: 'Search traffic' })).toHaveValue('')
        await expect(page.locator('tr[data-request-id]')).toHaveCount(0)
        await expect.poll(async () => (await state(app, 'copy-url')).enabled).toBe(false)
        expect((await state(app, 'export-selected')).enabled).toBe(false)
        // Invalid display-state IPC cannot invoke an action or bypass validation.
        const invalid = await page.evaluate(async () => {
            try {
                await window.fluxy.menuState({ command: 'clear' } as never)
                return false
            } catch {
                return true
            }
        })
        expect(invalid).toBe(true)
        expect(errors).toEqual([])
    } finally {
        await app.close()
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
    }
})

test('menu commands already in transit wait for an active operation to finish', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-menu-inflight-'))
    const app = await electron.launch({
        args: process.env.FLUXY_TEST_EXECUTABLE ? [] : ['.'],
        ...(process.env.FLUXY_TEST_EXECUTABLE
            ? { executablePath: process.env.FLUXY_TEST_EXECUTABLE }
            : {}),
        env: { ...process.env, FLUXY_DATA_DIR: directory }
    })
    const releaseCopy = () =>
        app.evaluate(() => {
            const hooks = globalThis as typeof globalThis & { releaseMenuCopy?: () => void }
            hooks.releaseMenuCopy?.()
            delete hooks.releaseMenuCopy
        })
    try {
        const page = await app.firstWindow()
        await page
            .getByRole('dialog', { name: 'Welcome to Fluxy' })
            .getByRole('button', { name: 'Close', exact: true })
            .click()
        // Import a local transaction without relying on network timing.
        const harPath = join(directory, 'request.har')
        await writeFile(
            harPath,
            JSON.stringify({
                log: {
                    entries: [
                        {
                            startedDateTime: new Date().toISOString(),
                            time: 1,
                            request: {
                                method: 'GET',
                                url: 'http://example.test/menu',
                                headers: []
                            },
                            response: {
                                status: 200,
                                headers: [],
                                content: { text: 'menu response' }
                            }
                        }
                    ]
                }
            })
        )
        await app.evaluate(({ dialog }, filePath) => {
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
            dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
        }, harPath)
        await click(app, 'import')
        await expect(page.locator('tr[data-request-id]')).toHaveCount(1)
        await click(app, 'last-request')
        await expect.poll(async () => (await state(app, 'copy-url')).enabled).toBe(true)
        await app.evaluate(({ ipcMain, clipboard }) => {
            ipcMain.removeHandler('fluxy:copy')
            ipcMain.handle('fluxy:copy', async (_event, text: string) => {
                clipboard.writeText(text)
                await new Promise<void>((resolve) => {
                    const hooks = globalThis as typeof globalThis & { releaseMenuCopy?: () => void }
                    hooks.releaseMenuCopy = resolve
                })
            })
        })
        for (const command of ['pin', 'Help']) {
            await click(app, 'copy-url')
            await expect.poll(async () => (await state(app, 'copy-url')).enabled).toBe(false)
            // Simulate a click sent before the renderer's busy state reached the
            // main process, but delivered after the copy operation started.
            await app.evaluate(({ BrowserWindow }, command) => {
                BrowserWindow.getAllWindows()[0].webContents.send('fluxy:event', {
                    type: 'command',
                    command
                })
            }, command)
            await expect(page.getByRole('dialog', { name: 'Help', exact: true })).toHaveCount(0)
            if (command === 'pin') {
                expect(
                    await page.evaluate(
                        async () => (await window.fluxy.snapshot()).transactions[0].pinned
                    )
                ).toBe(false)
            }
            await releaseCopy()
            if (command === 'pin') {
                await expect
                    .poll(() =>
                        page.evaluate(
                            async () => (await window.fluxy.snapshot()).transactions[0].pinned
                        )
                    )
                    .toBe(true)
                await expect.poll(async () => (await state(app, 'pin')).checked).toBe(true)
            } else {
                await expect(page.getByRole('dialog', { name: 'Help', exact: true })).toContainText(
                    'Inspect traffic with Fluxy'
                )
            }
        }
    } finally {
        await releaseCopy()
        await app.close()
        await rm(directory, { recursive: true, force: true })
    }
})

test('project menus persist tabs and filters across switching and restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-project-menu-'))
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
        const initial = await page.evaluate(() => window.fluxy.snapshot())
        const defaultID = initial.projects.activeID
        await page.getByRole('textbox', { name: 'Search traffic' }).fill('original filter')
        await click(app, 'new-project')
        await page.getByLabel('Project name').fill('API Project')
        await page.getByRole('button', { name: 'Create Project', exact: true }).click()
        await expect(page.getByRole('textbox', { name: 'Search traffic' })).toHaveValue('')
        const apiID = await page.evaluate(
            async () => (await window.fluxy.snapshot()).projects.activeID
        )
        expect(apiID).not.toBe(defaultID)
        await click(app, 'new-workspace')
        await page.getByRole('textbox', { name: 'Search traffic' }).fill('api filter')
        await click(app, `project:${defaultID}`)
        await expect(page.getByRole('textbox', { name: 'Search traffic' })).toHaveValue(
            'original filter'
        )
        await expect.poll(async () => (await workspaceState(page)).count).toBe(1)
        await click(app, `project:${apiID}`)
        await expect(page.getByRole('textbox', { name: 'Search traffic' })).toHaveValue(
            'api filter'
        )
        await expect.poll(async () => (await workspaceState(page)).count).toBe(2)
        await click(app, 'rename-project')
        await page.getByLabel('Project name').fill('Renamed API')
        await page.getByRole('button', { name: 'Rename Project', exact: true }).click()
        await expect
            .poll(async () => (await state(app, `project:${apiID}`)).label)
            .toBe('Renamed API')
        await click(app, 'Keyboard Shortcuts')
        await expect(page.getByRole('dialog')).toContainText('New Tab')
        await expect(page.getByRole('dialog')).toContainText('CmdOrCtrl+T')
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
        await click(app, 'automatic-setup')
        await expect(page.getByRole('dialog', { name: 'Automatic Setup' })).toContainText(
            'NODE_EXTRA_CA_CERTS'
        )
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
        expect(
            await app.evaluate(({ Menu }) =>
                [
                    'setup:iOS Simulator',
                    'setup:iPhone or iPad',
                    'setup:Android Emulator',
                    'setup:Android Device',
                    'setup:Java',
                    'setup:Flutter',
                    'setup:React Native',
                    'setup:Electron',
                    'setup:Next.js',
                    'setup:Firefox'
                ].filter((id) => Menu.getApplicationMenu()!.getMenuItemById(id))
            )
        ).toEqual([])
        await app.close()
        app = await launch()
        page = await app.firstWindow()
        const welcome = page.getByRole('dialog', { name: 'Welcome to Fluxy' })
        await welcome.getByRole('button', { name: 'Close', exact: true }).click()
        await expect(page.getByRole('textbox', { name: 'Search traffic' })).toHaveValue(
            'api filter'
        )
        await expect.poll(async () => (await workspaceState(page)).count).toBe(2)
        await expect.poll(async () => (await state(app, `project:${apiID}`)).checked).toBe(true)
        await click(app, `project:${defaultID}`)
        await expect(page.getByRole('textbox', { name: 'Search traffic' })).toHaveValue(
            'original filter'
        )
    } finally {
        await app.close()
        await rm(directory, { recursive: true, force: true })
    }
})
