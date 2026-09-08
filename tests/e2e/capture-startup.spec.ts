import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { once } from 'node:events'

const launch = (directory: string) =>
    electron.launch({
        args: process.env.FLUXY_TEST_EXECUTABLE ? [] : ['.'],
        ...(process.env.FLUXY_TEST_EXECUTABLE
            ? { executablePath: process.env.FLUXY_TEST_EXECUTABLE }
            : {}),
        env: { ...process.env, FLUXY_DATA_DIR: directory }
    })

test('successful setup remembers SOCKS mode and restores it until auto-start is disabled', async () => {
    test.setTimeout(90000)
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-capture-startup-'))
    const occupied = net.createServer().listen(0, '127.0.0.1')
    await once(occupied, 'listening')
    const port = (occupied.address() as net.AddressInfo).port
    await writeFile(
        join(directory, 'preferences.json'),
        JSON.stringify({
            settings: { captureMode: 'proxy', autoSystemProxy: false, port },
            rules: []
        })
    )
    let app = await launch(directory)
    try {
        let page = await app.firstWindow()
        let welcome = page.getByRole('dialog', { name: 'Welcome to Fluxy' })
        await expect(welcome.getByRole('tab', { name: 'Socks Proxy' })).toHaveAttribute(
            'aria-selected',
            'true'
        )
        await welcome.getByRole('button', { name: 'Enable', exact: true }).click()
        await expect(welcome.getByRole('alert')).toBeVisible()
        expect((await page.evaluate(() => window.fluxy.snapshot())).settings.autoStart).toBe(false)
        await new Promise<void>((resolve) => occupied.close(() => resolve()))
        await welcome.getByRole('button', { name: 'Enable', exact: true }).click()
        await expect
            .poll(
                async () => (await page.evaluate(() => window.fluxy.snapshot())).settings.autoStart
            )
            .toBe(true)
        expect((await page.evaluate(() => window.fluxy.snapshot())).running).toBe(true)
        expect(
            JSON.parse(await readFile(join(directory, 'preferences.json'), 'utf8')).settings
        ).toMatchObject({
            captureMode: 'proxy',
            autoSystemProxy: false,
            autoStart: true,
            port
        })
        await app.close()
        app = await launch(directory)
        page = await app.firstWindow()
        welcome = page.getByRole('dialog', { name: 'Welcome to Fluxy' })
        await expect
            .poll(async () => (await page.evaluate(() => window.fluxy.snapshot())).running)
            .toBe(true)
        await expect(welcome.getByRole('tab', { name: 'Socks Proxy' })).toHaveAttribute(
            'aria-selected',
            'true'
        )
        const restored = await page.evaluate(() => window.fluxy.snapshot())
        expect(restored.settings.port).toBe(port)
        expect(restored.systemProxy).toBe(false)
        await page.evaluate(async () => {
            const { settings } = await window.fluxy.snapshot()
            await window.fluxy.settings({ ...settings, autoStart: false })
        })
        await app.close()
        app = await launch(directory)
        page = await app.firstWindow()
        await expect(page.getByRole('dialog', { name: 'Welcome to Fluxy' })).toBeVisible()
        const disabled = await page.evaluate(() => window.fluxy.snapshot())
        expect(disabled.settings.captureMode).toBe('proxy')
        expect(disabled.settings.autoStart).toBe(false)
        expect(disabled.running).toBe(false)
        expect(disabled.systemProxy).toBe(false)
    } finally {
        await app.close()
        occupied.close()
        await rm(directory, { recursive: true, force: true })
    }
})

test('TUN auto-start attempts the saved mode and reports an unavailable exit without changing modes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-tun-startup-'))
    await writeFile(
        join(directory, 'preferences.json'),
        JSON.stringify({
            settings: {
                onboardingCompleted: true,
                showWelcomeOnLaunch: false,
                captureMode: 'tun',
                autoStart: true,
                tun: { interface: 'fluxy-missing-interface', routeCIDRs: ['203.0.113.123/32'] }
            },
            rules: []
        })
    )
    const app = await launch(directory)
    try {
        const page = await app.firstWindow()
        await expect
            .poll(async () => (await page.evaluate(() => window.fluxy.snapshot())).tun.state)
            .toBe('error')
        const state = await page.evaluate(() => window.fluxy.snapshot())
        expect(state.tun.error).toContain('Selected exit interface is unavailable')
        expect(state.settings.captureMode).toBe('tun')
        expect(state.settings.autoStart).toBe(true)
        expect(state.settings.tun.routeCIDRs).toEqual(['203.0.113.123/32'])
        expect(state.running).toBe(false)
        expect(state.systemProxy).toBe(false)
    } finally {
        await app.close()
        await rm(directory, { recursive: true, force: true })
    }
})
