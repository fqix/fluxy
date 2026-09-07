import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
test('real updater downloads a local fixture and rejects a checksum mismatch without installing', async () => {
    test.skip(process.platform !== 'darwin')
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-updater-'))
    // Empty ZIP: valid transport fixture, deliberately not an installable application.
    const zip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex')
    let corrupt = false,
        downloads = 0
    const hash = createHash('sha512').update(zip).digest('base64')
    const server = http.createServer((req, res) => {
        if (req.url?.split('?')[0].endsWith('.yml')) {
            res.end(
                `version: 99.0.${corrupt ? 1 : 0}\nfiles:\n  - url: Fluxy-99.0.${corrupt ? 1 : 0}-${process.arch}.zip\n    sha512: ${corrupt ? createHash('sha512').update('wrong').digest('base64') : hash}\n    size: ${zip.length}\npath: Fluxy-99.0.${corrupt ? 1 : 0}-${process.arch}.zip\nsha512: ${hash}\n`
            )
        } else {
            downloads++
            res.end(zip)
        }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    const config = join(directory, 'update.yml')
    await writeFile(
        config,
        `provider: generic\nurl: ${url}\nupdaterCacheDirName: fluxy-fixture-${Date.now()}\n`
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
        await expect(page.getByRole('dialog')).toBeVisible()
        const result = await app.evaluate(
            async ({ app }, { url, config, directory }) => {
                const { createRequire } = process.getBuiltinModule('module')
                const { autoUpdater } = createRequire(app.getAppPath() + '/package.json')(
                    'electron-updater'
                )
                autoUpdater.forceDevUpdateConfig = true
                autoUpdater.updateConfigPath = config
                autoUpdater.autoDownload = false
                autoUpdater.autoInstallOnAppQuit = false
                // Isolate updater cache from every real Fluxy installation.
                app.setPath('cache', directory)
                autoUpdater.setFeedURL({ provider: 'generic', url, useMultipleRangeRequest: false })
                const info = await autoUpdater.checkForUpdates()
                await autoUpdater.downloadUpdate()
                return info?.updateInfo.version
            },
            { url, config, directory }
        )
        expect(result).toBe('99.0.0')
        expect(downloads).toBe(1)
        corrupt = true
        const failure = await app.evaluate(async ({ app }) => {
            const { createRequire } = process.getBuiltinModule('module')
            const { autoUpdater } = createRequire(app.getAppPath() + '/package.json')(
                'electron-updater'
            )
            try {
                await autoUpdater.checkForUpdates()
                await autoUpdater.downloadUpdate()
                return ''
            } catch (e) {
                return String(e)
            }
        })
        expect(failure).toMatch(/sha512|checksum/i)
    } finally {
        await app.close()
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
    }
})
