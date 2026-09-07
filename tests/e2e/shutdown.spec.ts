import { test, expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { executableName } from '../../src/main/helper-platform'

const electronPath = createRequire(join(process.cwd(), 'package.json'))('electron') as string
const resources = process.env.FLUXY_TEST_EXECUTABLE
    ? resolve(dirname(process.env.FLUXY_TEST_EXECUTABLE), '..', 'Resources')
    : undefined
const appPath = resources ? join(resources, 'app.asar') : process.cwd()

for (const phase of [
    `${executableName('fluxy-helper')}.json`,
    `${executableName('fluxy-core')}.build.json`
]) {
    test(`quit during ${phase} initialization waits and cleans up partial services`, async ({}, testInfo) => {
        const directory = await mkdtemp(join(tmpdir(), 'fluxy-early-quit-'))
        const report = join(directory, 'events.json')
        const bootstrap = join(directory, 'bootstrap.cjs')
        // Instrument only this isolated Electron process, before the real main
        // bundle loads. No production test switch or privileged operation is used.
        await writeFile(
            bootstrap,
            `
const { app, dialog } = require('electron')
const fs = require('node:fs')
const promises = require('node:fs/promises')
const events = []
const record = event => {
    events.push(event)
    fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(events))
}
app.getAppPath = () => ${JSON.stringify(appPath)}
${
    resources
        ? `Object.defineProperty(app, 'isPackaged', { value: true })
Object.defineProperty(process, 'resourcesPath', { value: ${JSON.stringify(resources)} })`
        : ''
}
dialog.showErrorBox = (title, message) => record({ error: title + ': ' + message })
app.on('browser-window-created', () => record('window-created'))
app.on('quit', () => record('quit'))
const original = promises.readFile
let paused = false
promises.readFile = async function(path, ...args) {
    if (!paused && String(path).endsWith(${JSON.stringify(phase)})) {
        paused = true
        record('initialization-paused')
        setImmediate(() => { record('quit-request'); app.quit() })
        setTimeout(() => { record('second-quit-request'); app.quit() }, 10)
        await new Promise(resolve => setTimeout(resolve, 100))
        const result = await original.call(this, path, ...args)
        record('initialization-finished')
        return result
    }
    return original.call(this, path, ...args)
}
require(${JSON.stringify(join(appPath, 'out/main/index.js'))})
`
        )
        try {
            // This direct launch needs the same test-only sandbox opt-out as Playwright.
            const args = process.platform === 'linux' ? ['--no-sandbox', bootstrap] : [bootstrap]
            await promisify(execFile)(electronPath, args, {
                env: { ...process.env, FLUXY_DATA_DIR: join(directory, 'data') },
                timeout: 15000
            })
            const events = JSON.parse(await readFile(report, 'utf8'))
            expect(events.filter((event: unknown) => typeof event !== 'string')).toEqual([])
            expect(events).toEqual([
                'initialization-paused',
                'quit-request',
                'second-quit-request',
                'initialization-finished',
                'quit'
            ])
        } catch (error) {
            await testInfo.attach('initialization-events', {
                body: await readFile(report).catch(() => Buffer.from('[]')),
                contentType: 'application/json'
            })
            throw error
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    })
}
