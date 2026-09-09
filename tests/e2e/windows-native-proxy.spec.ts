import { test, expect, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type AddressInfo } from 'node:net'
import { once } from 'node:events'
import {
    desktopProxyBackend,
    desktopProxyBackupSchema,
    restoreDesktopProxy
} from '../../src/main/system/desktop-proxy'

test('native Windows system proxy captures traffic and restores after Stop and a crash', async ({}, testInfo) => {
    test.skip(
        process.platform !== 'win32' || process.env.FLUXY_TEST_NATIVE_PROXY !== '1',
        'Opt in to a real current-user system proxy test'
    )
    test.setTimeout(90000)
    const helper = resolve('build/electron-helper/fluxy-helper.exe')
    const native = (state?: Record<string, string>) =>
        new Promise<unknown>((resolve, reject) => {
            const child = execFile(
                helper,
                ['system-proxy'],
                { windowsHide: true, timeout: 10000 },
                (error, stdout, stderr) => {
                    if (error) reject(new Error(stderr || error.message))
                    else {
                        try {
                            resolve(JSON.parse(stdout))
                        } catch (error) {
                            reject(error)
                        }
                    }
                }
            )
            child.stdin?.on('error', reject)
            child.stdin?.end(JSON.stringify(state ?? null))
        })
    const backend = await desktopProxyBackend('win32', {}, undefined, undefined, native)
    const previous = await backend.read()
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-native-proxy-'))
    const backupPath = join(directory, 'system-proxy-backup.json')
    const reservation = createServer().listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const port = (reservation.address() as AddressInfo).port
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    await writeFile(
        join(directory, 'preferences.json'),
        JSON.stringify({
            rules: [],
            settings: {
                captureMode: 'proxy',
                port,
                autoStart: false,
                autoSystemProxy: true,
                ssl: false,
                onboardingCompleted: true,
                showWelcomeOnLaunch: false
            }
        })
    )
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined
    let crashed = false
    try {
        app = await electron.launch({
            args: ['.'],
            env: { ...process.env, FLUXY_DATA_DIR: directory }
        })
        const page = await app.firstWindow()
        await page.evaluate(() => window.fluxy.start())
        const applied = backend.target(previous, port)
        expect(await backend.read()).toEqual(applied)
        expect((await page.evaluate(() => window.fluxy.snapshot())).systemProxy).toBe(true)
        const url = `http://example.com/?fluxy-native-proxy=${Date.now()}`
        const result = await app.evaluate(async ({ session }, url) => {
            const browser = session.fromPartition('native-proxy-check')
            await browser.setProxy({ mode: 'system' })
            const proxy = await browser.resolveProxy(url)
            const response = await browser.fetch(url, { signal: AbortSignal.timeout(10000) })
            await response.text()
            return { proxy, status: response.status }
        }, url)
        expect(result.proxy).toContain(`127.0.0.1:${port}`)
        expect(result.status).toBe(200)
        await expect
            .poll(async () =>
                (await page.evaluate(() => window.fluxy.snapshot())).transactions.some(
                    (t) => t.url === url && t.status === 200
                )
            )
            .toBe(true)
        await page.evaluate(() => window.fluxy.stop())
        expect(await backend.read()).toEqual(previous)
        await expect(access(backupPath)).rejects.toThrow()
        await page.evaluate(() => window.fluxy.start())
        expect(await backend.read()).toEqual(applied)
        const mainPID = await app.evaluate(() => process.pid)
        process.kill(mainPID, 'SIGKILL')
        crashed = true
        await expect.poll(() => backend.read(), { timeout: 15000 }).toEqual(previous)
        await expect
            .poll(async () =>
                access(backupPath).then(
                    () => false,
                    () => true
                )
            )
            .toBe(true)
        await testInfo.attach('native-proxy-result', {
            body: JSON.stringify({ result, normalStopRestored: true, crashRestored: true }),
            contentType: 'application/json'
        })
    } finally {
        if (app && !crashed) await app.close()
        // Preserve concurrent edits by another application even on assertion failure.
        try {
            const backup = desktopProxyBackupSchema.parse(
                JSON.parse(await readFile(backupPath, 'utf8'))
            )
            await restoreDesktopProxy(backup, backend)
            await rm(backupPath)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    }
})
