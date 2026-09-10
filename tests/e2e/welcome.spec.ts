import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, readFile, access, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { once } from 'node:events'

test('first-run setup reads real status, handles cancellation and persists explicit completion', async () => {
    test.setTimeout(90000)
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-welcome-'))
    const launch = () =>
        electron.launch({
            args: process.env.FLUXY_TEST_EXECUTABLE ? [] : ['.'],
            ...(process.env.FLUXY_TEST_EXECUTABLE
                ? { executablePath: process.env.FLUXY_TEST_EXECUTABLE }
                : {}),
            env: { ...process.env, FLUXY_DATA_DIR: directory }
        })
    let app = await launch()
    const occupied = net.createServer()
    occupied.listen(0, '127.0.0.1')
    await once(occupied, 'listening')
    const port = (occupied.address() as net.AddressInfo).port
    try {
        let page = await app.firstWindow()
        let welcome = page.getByRole('dialog', { name: 'Welcome to Fluxy' })
        await expect(welcome).toBeVisible()
        await expect(welcome.getByRole('status')).toHaveText('0 of 3 complete')
        await expect(welcome.getByRole('listitem')).toHaveCount(3)
        await expect(welcome.getByRole('listitem').first()).toContainText('Helper Setup')
        await expect(
            welcome.getByRole('button', { name: 'Install CA', exact: true })
        ).toBeDisabled()
        await expect(welcome.getByRole('button', { name: 'Enable', exact: true })).toBeDisabled()
        const captureDomains = welcome.getByRole('textbox', {
            name: 'Capture domains',
            exact: true
        })
        await expect(captureDomains).toHaveValue('github.com\ngoogle.com')
        await expect(captureDomains).toHaveAttribute('aria-invalid', 'false')
        await captureDomains.fill('')
        await expect(captureDomains).toHaveAttribute('aria-invalid', 'true')
        await expect(welcome.locator('#welcome-capture-domains-error')).toContainText(
            'at least one capture domain'
        )
        await captureDomains.fill('https://example.com')
        await expect(captureDomains).toHaveAttribute('aria-invalid', 'true')
        await expect(welcome.locator('#welcome-capture-domains-error')).toContainText(
            'without a URL'
        )
        await expect(
            welcome.getByRole('button', { name: 'Save Domains', exact: true })
        ).toHaveCount(0)
        await welcome
            .getByRole('textbox', { name: 'Capture domains', exact: true })
            .fill('example.com')
        await expect(captureDomains).toHaveAttribute('aria-invalid', 'false')
        // Editing alone does not save: Enable owns saving and starting capture.
        expect(
            (await page.evaluate(() => window.fluxy.snapshot())).settings.tun.captureDomains
        ).toEqual([])
        await welcome.getByRole('tab', { name: 'Socks Proxy', exact: true }).click()
        await expect(
            welcome.getByRole('tab', { name: 'Socks Proxy', exact: true })
        ).toHaveAttribute('aria-selected', 'true')
        await expect(welcome.getByRole('spinbutton', { name: 'SOCKS5 port' })).toHaveCount(0)
        await expect(welcome.getByRole('tabpanel')).toContainText('127.0.0.1:6060')
        await expect(
            welcome.getByRole('textbox', { name: 'Capture domains', exact: true })
        ).toHaveCount(0)
        await welcome.getByRole('tab', { name: 'TUN Capture', exact: true }).click()
        await expect(
            welcome.getByRole('textbox', { name: 'Capture domains', exact: true })
        ).toHaveValue('example.com')
        await expect(welcome.getByRole('alert')).toHaveCount(0)
        await mkdir('test-results', { recursive: true })
        await page.screenshot({ path: 'test-results/fluxy-welcome-tun.png' })
        await expect(welcome.getByRole('button', { name: 'Get Started' })).toBeDisabled()
        await expect(access(join(directory, 'certificates/certs/ca.pem'))).rejects.toThrow()
        const initial = await page.evaluate(() => window.fluxy.snapshot())
        expect(initial.settings.captureMode).toBe('tun')
        expect(initial.running).toBe(false)
        expect(initial.systemProxy).toBe(false)
        await welcome.getByRole('checkbox', { name: 'Show on startup' }).uncheck()
        await expect(welcome.getByRole('status')).toHaveText('0 of 3 complete')
        await welcome.getByRole('button', { name: 'Close', exact: true }).click()
        expect(
            (await page.evaluate(() => window.fluxy.snapshot())).settings.onboardingCompleted
        ).toBe(false)
        await app.close()
        app = await launch()
        page = await app.firstWindow()
        welcome = page.getByRole('dialog', { name: 'Welcome to Fluxy' })
        await expect(welcome).toBeVisible() // Close is not completion, even with startup unchecked.
        await expect(welcome.getByRole('status')).toHaveText('0 of 3 complete')
        await expect(
            welcome.getByRole('textbox', { name: 'Capture domains', exact: true })
        ).toHaveValue('github.com\ngoogle.com')
        await app.evaluate(() => {
            const cp = process.getBuiltinModule('node:child_process')!
            const original = cp.spawn
            cp.spawn = ((file: string, ...args: unknown[]) =>
                (args[0] as string[] | undefined)?.[0] === 'authorize-desktop' ||
                file === '/usr/bin/pkexec' ||
                (args[0] as string[] | undefined)?.[0] === 'setup-native'
                    ? original(
                          process.execPath,
                          ['-e', 'process.stderr.write("Authorization canceled"); process.exit(1)'],
                          { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
                      )
                    : Reflect.apply(original, cp, [file, ...args])) as typeof cp.spawn
        })
        await welcome.getByRole('button', { name: 'Install Helper', exact: true }).click()
        await expect(welcome.getByRole('status')).toHaveText('0 of 3 complete', { timeout: 20000 })
        await expect(welcome.getByRole('alert').first()).toContainText('Authorization canceled')
        expect((await page.evaluate(() => window.fluxy.certificateStatus())).trusted).toBe(false)
        await expect(access(join(directory, 'certificates/certs/ca.pem'))).rejects.toThrow()
        await expect(welcome.getByRole('alert').first()).toBeVisible()
        await expect(welcome.getByRole('button', { name: 'Enable', exact: true })).toBeDisabled()
        await page.evaluate(async (port) => {
            const s = await window.fluxy.snapshot()
            await window.fluxy.settings({ ...s.settings, port, captureMode: 'proxy' })
        }, port)
        await welcome.getByRole('button', { name: 'Enable', exact: true }).click()
        await expect(
            welcome.getByRole('alert').filter({ hasText: /EADDRINUSE|address already in use/ })
        ).toBeVisible()
        expect((await page.evaluate(() => window.fluxy.snapshot())).systemProxy).toBe(false)
        const certificate = await readFile(join(directory, 'certificates/certs/ca.pem'), 'utf8')
        await welcome.getByRole('button', { name: 'Use Manual Setup' }).click()
        await mkdir('test-results', { recursive: true })
        await page.screenshot({ path: 'test-results/fluxy-welcome-light.png' })
        await page.evaluate(async () => {
            const s = await window.fluxy.snapshot()
            await window.fluxy.settings({ ...s.settings, theme: 'dark' })
        })
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
        await page.screenshot({ path: 'test-results/fluxy-welcome-dark.png' })
        await welcome.getByRole('button', { name: 'Debug My App…' }).click()
        await expect(page.getByRole('dialog', { name: 'Developer Setup' })).toBeVisible()
        await app.close()
        app = await launch()
        page = await app.firstWindow()
        await expect(page.getByRole('heading', { name: 'Ready to capture traffic' })).toBeVisible()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await app.evaluate(({ Menu, BrowserWindow }) => {
            const item = Menu.getApplicationMenu()!.getMenuItemById('Welcome to Fluxy')!
            item.click(undefined as never, BrowserWindow.getAllWindows()[0], {} as never)
        })
        welcome = page.getByRole('dialog', { name: 'Welcome to Fluxy' })
        await expect(welcome).toBeVisible()
        await expect(welcome.getByRole('status')).toHaveText('0 of 3 complete')
        expect(await readFile(join(directory, 'certificates/certs/ca.pem'), 'utf8')).toBe(
            certificate
        )
        const state = await page.evaluate(() => window.fluxy.snapshot())
        expect(state.settings.onboardingCompleted).toBe(true)
        expect(state.settings.captureMode).toBe('proxy')
        expect(state.settings.showWelcomeOnLaunch).toBe(false)
        expect(state.running).toBe(false)
        expect(state.systemProxy).toBe(false)
    } finally {
        await app.close()
        occupied.close()
        await rm(directory, { recursive: true, force: true })
    }
})
