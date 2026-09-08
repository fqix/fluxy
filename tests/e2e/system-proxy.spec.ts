import { createServer, type AddressInfo } from 'node:net'
import { once } from 'node:events'
import { test, expect, _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile, rm, access, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

test('HTTP capture automatically manages system proxy, rolls back errors and persists opt-out', async () => {
    test.skip(
        process.platform !== 'darwin',
        'macOS command adapter; Windows/Linux adapters have isolated unit coverage'
    )
    test.setTimeout(90000)
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-auto-proxy-'))
    const report = join(directory, 'system.json'),
        bootstrap = join(directory, 'bootstrap.cjs')
    const data = join(directory, 'data')
    const listener = createServer().listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const port = (listener.address() as AddressInfo).port
    await new Promise<void>((resolve) => listener.close(() => resolve()))
    await mkdir(data, { recursive: true })
    await writeFile(
        join(data, 'preferences.json'),
        JSON.stringify({ settings: { port }, rules: [] })
    )

    const electronPath = createRequire(join(process.cwd(), 'package.json'))('electron') as string
    const resources = process.env.FLUXY_TEST_EXECUTABLE
        ? resolve(dirname(process.env.FLUXY_TEST_EXECUTABLE), '..', 'Resources')
        : undefined
    const appPath = resources ? join(resources, 'app.asar') : process.cwd()
    // Load the real main/preload/renderer, intercepting OS writes before imports
    // capture execFile. Neither networksetup nor the recovery watchdog runs here.
    await writeFile(
        bootstrap,
        `
const { app, dialog } = require('electron')
const fs = require('node:fs')
const cp = require('node:child_process')
const { promisify } = require('node:util')
const { EventEmitter } = require('node:events')
app.getAppPath = () => ${JSON.stringify(appPath)}
${
    resources
        ? `Object.defineProperty(app, 'isPackaged', { value: true })
Object.defineProperty(process, 'resourcesPath', { value: ${JSON.stringify(resources)} })`
        : ''
}
const values = {
 webproxy: { server: 'previous-http', port: '8080', enabled: true },
 securewebproxy: { server: 'previous-https', port: '8443', enabled: false }
}
const state = global.__proxyTest = { values, commands: [], failSetup: false, errors: [] }
const save = () => fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(state))
dialog.showErrorBox = (title, message) => { state.errors.push(title + ': ' + message); save() }
const originalExec = promisify(cp.execFile)
cp.execFile[promisify.custom] = async (file, args, ...rest) => {
 if (file !== '/usr/sbin/networksetup') return originalExec(file, args, ...rest)
 state.commands.push(args)
 if (args[0] === '-listallnetworkservices') return { stdout: 'Services\\nWi-Fi\\n', stderr: '' }
 const match = args[0].match(/^-(get|set)(webproxy|securewebproxy)(state)?$/)
 if (!match) throw new Error('Unexpected system command')
 const item = values[match[2]]
 if (match[1] === 'get') return { stdout: 'Enabled: ' + (item.enabled ? 'Yes' : 'No') + '\\nServer: ' + item.server + '\\nPort: ' + item.port + '\\nAuthenticated Proxy Enabled: 0\\n', stderr: '' }
 if (state.failSetup && args[0] === '-setsecurewebproxy' && args[2] === '127.0.0.1') throw new Error('Simulated setup denied')
 if (match[3]) item.enabled = args[2] === 'on'
 else { item.server = args[2]; item.port = args[3] }
 save()
 return { stdout: '', stderr: '' }
}
const originalSpawn = cp.spawn
cp.spawn = function(file, args, ...rest) {
 if (args && args.some(arg => String(arg).endsWith('watchdog.js'))) return Object.assign(new EventEmitter(), { unref() {}, kill() {} })
 if (file === '/usr/bin/osascript') throw new Error('Unexpected authorization request')
 return originalSpawn.call(this, file, args, ...rest)
}
app.on('quit', save)
require(${JSON.stringify(join(appPath, 'out/main/index.js'))})
`
    )
    const launch = () =>
        electron.launch({
            executablePath: electronPath,
            args: [bootstrap],
            env: { ...process.env, FLUXY_DATA_DIR: data }
        })
    let app = await launch()
    try {
        let page = await app.firstWindow()
        await page
            .getByRole('dialog', { name: 'Welcome to Fluxy' })
            .getByRole('button', { name: 'Close', exact: true })
            .click()
        await page.getByRole('button', { name: 'Proxy status and connection setup' }).click()
        await page.getByRole('combobox', { name: 'Capture mode' }).selectOption('proxy')
        const automatic = page.getByRole('checkbox', {
            name: 'Automatically set system proxy when capture starts'
        })
        await expect(automatic).toBeChecked()
        await page.evaluate(() => window.fluxy.start())
        expect((await page.evaluate(() => window.fluxy.snapshot())).systemProxy).toBe(true)
        await expect(automatic).toBeDisabled()
        await page.evaluate(() => window.fluxy.stop())
        expect((await page.evaluate(() => window.fluxy.snapshot())).systemProxy).toBe(false)
        await expect(access(join(data, 'system-proxy-backup.json'))).rejects.toThrow()
        await app.evaluate(() => {
            ;(globalThis as any).__proxyTest.failSetup = true
        })
        const error = await page.evaluate(async () => {
            try {
                await window.fluxy.start()
                return ''
            } catch (error) {
                return String(error)
            }
        })
        expect(error).toContain('Simulated setup denied')
        const failed = await page.evaluate(() => window.fluxy.snapshot())
        expect(failed.running).toBe(false)
        expect(failed.systemProxy).toBe(false)
        await expect(access(join(data, 'system-proxy-backup.json'))).rejects.toThrow()
        await automatic.click()
        await expect(automatic).not.toBeChecked()
        await expect
            .poll(
                async () =>
                    (await page.evaluate(() => window.fluxy.snapshot())).settings.autoSystemProxy
            )
            .toBe(false)
        const before = await app.evaluate(() => (globalThis as any).__proxyTest.commands.length)
        await page.evaluate(() => window.fluxy.start())
        expect((await page.evaluate(() => window.fluxy.snapshot())).running).toBe(true)
        expect(await app.evaluate(() => (globalThis as any).__proxyTest.commands.length)).toBe(
            before
        )
        await page.evaluate(async () => {
            await window.fluxy.stop()
            const s = await window.fluxy.snapshot()
            await window.fluxy.settings({
                ...s.settings,
                onboardingCompleted: true,
                showWelcomeOnLaunch: false
            })
        })
        await app.close()
        app = await launch()
        page = await app.firstWindow()
        expect((await page.evaluate(() => window.fluxy.snapshot())).settings.autoSystemProxy).toBe(
            false
        )
        // Auto-start must follow the same path as the toolbar, including cleanup on quit.
        await page.evaluate(async () => {
            const s = await window.fluxy.snapshot()
            await window.fluxy.settings({ ...s.settings, autoSystemProxy: true, autoStart: true })
        })
        await app.close()
        app = await launch()
        page = await app.firstWindow()
        await expect
            .poll(async () => (await page.evaluate(() => window.fluxy.snapshot())).systemProxy)
            .toBe(true)
        await app.close()
        const saved = JSON.parse(await readFile(report, 'utf8'))
        expect(saved.values).toEqual({
            webproxy: { server: 'previous-http', port: '8080', enabled: true },
            securewebproxy: { server: 'previous-https', port: '8443', enabled: false }
        })
        expect(saved.errors).toEqual([])
        await expect(access(join(data, 'system-proxy-backup.json'))).rejects.toThrow()
    } finally {
        await app.close().catch(() => {})
        await rm(directory, { recursive: true, force: true })
    }
})
