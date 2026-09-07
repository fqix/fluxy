import { executableName, supportedHelperPlatform } from './helper-platform'
import { autoUpdater } from 'electron-updater'
import { UpdateService } from './updates'
import {
    app,
    BrowserWindow,
    ipcMain,
    Menu,
    dialog,
    clipboard,
    nativeTheme,
    shell,
    safeStorage
} from 'electron'
import { join } from 'node:path'
import { readFile, writeFile, stat, copyFile, rm, mkdir, chmod } from 'node:fs/promises'
import { terminalEnvironment } from '../shared/setup'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { X509Certificate } from 'node:crypto'
import forge from 'node-forge'
import { HelperService } from './helper'
import { z } from 'zod'
import { Store } from './store'
import { TunService } from './tun'
import { networkInterfaces } from 'node:os'
import { ProxyEngine } from './proxy'
import { ScriptRunner } from './scripting'
import { MCPService } from './mcp'
import { SystemProxy } from './system-proxy'
import { CaptureController } from './capture'
import { ensureCertificate, certificateStatus } from './certificates'
import {
    highlightSchema,
    breakpointEditSchema,
    breakpointTemplateSchema,
    settingsSchema,
    ruleSchema,
    scriptSchema,
    composeSchema,
    type AppEvent,
    type Snapshot
} from '../shared/model'
import { fromHAR, toHAR } from '../shared/har'
import { initialMenuState, menuStateSchema, type MenuCommand, type MenuState } from '../shared/menu'
import { buildMenuTemplate, updateMenuItems } from './menu'
import { stopServices } from './lifecycle'
import { writePrivateFile } from './private-files'
import { compareTransactions, diffText } from './diff'
import { DiffWorkspace } from './diff-workspace'
import type { DiffResult } from '../shared/diff'
import { ProjectStore } from './projects'
import { GistService } from './gist'
import { CustomCertificates, certificateImportSchema } from './custom-certificates'
import { compileProtobuf, decodeProtobuf } from './protobuf'
import { projectActionSchema } from '../shared/projects'
import { toOpenAPI, toYAML, openAPIHTML } from '../shared/openapi'

app.setName('Fluxy')
app.setPath(
    'userData',
    process.env.FLUXY_DATA_DIR || join(app.getPath('appData'), 'dev.fengqi.fluxy.electron')
)
process.umask(0o077)
let window: BrowserWindow | null = null
let customCertificates: CustomCertificates
let projects: ProjectStore
let comparisons: DiffWorkspace
let updater: UpdateService
let store: Store
let engine: ProxyEngine
let tun: TunService
let helper: HelperService
let systemProxy: SystemProxy
let capture: CaptureController
let mcp: MCPService
const scripts = new ScriptRunner()
const gist = new GistService()
let quitting = false
let cleanupComplete = false
const events = new Map<string, AppEvent>()
function emit(event: AppEvent) {
    if (event.type === 'transaction') events.set(event.transaction.id, event)
    else if (window && !window.isDestroyed()) window.webContents.send('fluxy:event', event)
}
setInterval(() => {
    if (window && !window.isDestroyed())
        for (const event of events.values()) window.webContents.send('fluxy:event', event)
    events.clear()
}, 100).unref()
function command(command: MenuCommand) {
    emit({ type: 'command', command })
}
let menuShape = ''
function updateMenu(state: MenuState) {
    const template = buildMenuTemplate(state, command, process.platform, app.isPackaged)
    const menu = Menu.getApplicationMenu()
    const shape = JSON.stringify(state.projects.map((p) => [p.id, p.name])) + state.projectError
    if (!menu || shape !== menuShape || !updateMenuItems(menu, template)) {
        Menu.setApplicationMenu(Menu.buildFromTemplate(template))
        menuShape = shape
    }
}
async function startCapture() {
    await capture.start()
    emit({ type: 'state' })
}
function registerIPC() {
    function handle(channel: string, fn: (...args: any[]) => unknown) {
        ipcMain.handle(`fluxy:${channel}`, async (event, ...args) => {
            if (quitting) throw new Error('Fluxy is shutting down')
            if (
                event.sender !== window?.webContents ||
                event.senderFrame !== window.webContents.mainFrame
            )
                throw new Error('Untrusted IPC sender')
            return fn(...args)
        })
    }
    handle('update', async (input) => {
        const action = z.enum(['check', 'download', 'cancel', 'install']).parse(input)
        if (action === 'check') await updater.check()
        if (action === 'download') await updater.download()
        if (action === 'cancel') updater.cancel()
        if (action === 'install') {
            try {
                await updater.install(async () => {
                    quitting = true
                    await capture?.settled()
                    const errors = await stopServices({
                        tun,
                        helper,
                        systemProxy,
                        engine,
                        mcp,
                        scripts
                    })
                    if (errors.length) throw new Error(errors.join('\n'))
                    cleanupComplete = true
                })
            } catch (error) {
                quitting = false
                cleanupComplete = false
                throw error
            }
        }
    })
    const lookup = (id: unknown) => {
        const key = z.string().uuid().parse(id)
        const value =
            engine.transactions.get(key) ??
            store.favorites.get(key) ??
            comparisons.pairs.flatMap((p) => [p.left, p.right]).find((t) => t.id === key)
        if (!value) throw new Error('Request is no longer available')
        return value
    }
    const targetSchema = z.enum(['Request', 'Response', 'Timing'])
    const textSchema = z.string().max(2 * 1024 * 1024)
    const textResult = (left: string, right: string): DiffResult => {
        const lines = diffText(left, right)
        return {
            sections: [{ title: 'Text', lines }],
            added: lines.filter((l) => l.type === 'added').length,
            removed: lines.filter((l) => l.type === 'removed').length
        }
    }
    const savedPair = (id: unknown) => {
        const pair = comparisons.pairs.find((p) => p.id === z.string().uuid().parse(id))
        if (!pair) throw new Error('Saved comparison no longer exists')
        return pair
    }
    handle('diff', (left, right, target) =>
        compareTransactions(lookup(left), lookup(right), targetSchema.parse(target))
    )
    handle('diff:text', (left, right) =>
        textResult(textSchema.parse(left), textSchema.parse(right))
    )
    handle('diff:history', () => comparisons.pairs)
    handle('diff:record', (left, right) => comparisons.record(lookup(left), lookup(right)))
    handle('diff:change', (id, patch) =>
        comparisons.change(
            z.string().uuid().parse(id),
            z
                .object({
                    pinned: z.boolean().optional(),
                    name: z.string().trim().min(1).max(200).optional(),
                    remove: z.boolean().optional()
                })
                .parse(patch)
        )
    )
    handle('diff:saved', (id, target) => {
        const pair = savedPair(id)
        return compareTransactions(pair.left, pair.right, targetSchema.parse(target))
    })
    handle('diff:export', async (input) => {
        const value = z
            .union([
                z.object({
                    left: z.string().uuid(),
                    right: z.string().uuid(),
                    target: targetSchema,
                    saved: z.string().uuid().optional()
                }),
                z.object({ textLeft: textSchema, textRight: textSchema })
            ])
            .parse(input)
        let result: DiffResult,
            left = 'Side A',
            right = 'Side B'
        if ('textLeft' in value) result = textResult(value.textLeft, value.textRight)
        else {
            const pair = value.saved
                ? savedPair(value.saved)
                : { left: lookup(value.left), right: lookup(value.right) }
            result = compareTransactions(pair.left, pair.right, value.target)
            left = pair.left.url
            right = pair.right.url
        }
        const path = await dialog.showSaveDialog(window!, {
            defaultPath: 'comparison.diff',
            filters: [{ name: 'Unified Diff', extensions: ['diff', 'txt'] }]
        })
        if (path.canceled || !path.filePath) return null
        const text =
            `--- ${left}\n+++ ${right}\n` +
            result.sections
                .map(
                    (s) =>
                        `@@ -1,${s.lines.filter((l) => l.type !== 'added').length} +1,${s.lines.filter((l) => l.type !== 'removed').length} @@ ${s.title}\n` +
                        s.lines
                            .map(
                                (l) =>
                                    (l.type === 'added' ? '+' : l.type === 'removed' ? '-' : ' ') +
                                    l.content
                            )
                            .join('\n')
                )
                .join('\n') +
            '\n'
        await writePrivateFile(path.filePath, text)
        return path.filePath
    })
    handle('setup:terminal', async (input) => {
        const mode = z.enum(['copy', 'open']).parse(input)
        if (mode === 'open' && process.platform !== 'darwin')
            throw new Error('Copy the prepared environment into a POSIX terminal on this platform')
        await startCapture()
        const command = terminalEnvironment(store.settings.port, engine.certificatePath)
        if (mode === 'open') {
            const directory = join(store.directory, 'setup')
            await mkdir(directory, { recursive: true, mode: 0o700 })
            const path = join(directory, 'Fluxy-Terminal.command')
            await writeFile(
                path,
                `#!/bin/zsh
${command}
exec /bin/zsh -i
`,
                { mode: 0o700 }
            )
            await chmod(path, 0o700)
            await promisify(execFile)('/usr/bin/open', ['-a', 'Terminal', path])
        }
        emit({ type: 'state' })
        return command
    })
    handle('certificate:custom-import', async (input) => {
        if (engine.running) throw new Error('Stop capture before changing custom certificates')
        const value = certificateImportSchema.parse(input)
        const result = await dialog.showOpenDialog(window!, {
            title: 'Import certificate identity',
            properties: ['openFile', 'multiSelections'],
            filters: [
                {
                    name: 'Certificate and private key',
                    extensions: ['pem', 'key', 'p12', 'pfx', 'crt']
                }
            ]
        })
        if (result.canceled) return
        if (result.filePaths.length > 2)
            throw new Error('Choose a P12 archive or a PEM certificate and private key')
        const data = []
        for (const path of result.filePaths) {
            if ((await stat(path)).size > 2 * 1024 * 1024)
                throw new Error('Certificate file exceeds 2 MB')
            data.push(await readFile(path))
        }
        customCertificates.import(value, data, /\.(p12|pfx)$/i.test(result.filePaths[0]))
        emit({ type: 'state' })
    })
    handle('certificate:custom-delete', (id) => {
        if (engine.running) throw new Error('Stop capture before changing custom certificates')
        customCertificates.delete(z.string().uuid().parse(id))
        emit({ type: 'state' })
    })
    handle('protobuf:types', () => compileProtobuf(store.settings.protobufSchemas).types)
    handle('protobuf:decode', (inputID, inputSide, inputType) => {
        const id = z.string().uuid().parse(inputID),
            side = z.enum(['request', 'response']).parse(inputSide),
            type = z.string().min(1).max(500).parse(inputType)
        const t = engine.transactions.get(id) ?? store.favorites.get(id)
        if (!t) throw new Error('Request no longer exists')
        const headers = side === 'request' ? t.requestHeaders : t.responseHeaders
        const base64 = side === 'request' ? t.requestBase64 : t.responseBase64
        const bytes = base64
            ? Buffer.from(base64, 'base64')
            : Buffer.from(side === 'request' ? t.requestBody : t.responseBody)
        return decodeProtobuf(
            store.settings.protobufSchemas,
            type,
            bytes,
            (headers['content-type'] ?? '').includes('grpc'),
            headers['grpc-encoding'],
            /^application\/grpc-web(?:[+;\s]|$)/i.test(headers['content-type'] ?? '')
        )
    })
    handle('gist:review', (input) => {
        const ids = new Set(z.array(z.string().uuid()).min(1).max(100).parse(input))
        return gist.review(
            [...new Map([...store.favorites, ...engine.transactions]).values()].filter((t) =>
                ids.has(t.id)
            )
        )
    })
    handle('gist:publish', (input) => gist.publish(input))
    handle('templates', (input) => {
        const templates = z.array(breakpointTemplateSchema).max(500).parse(input)
        if (new Set(templates.map((t) => t.id)).size !== templates.length)
            throw new Error('Duplicate template IDs')
        const previous = store.templates
        store.templates = templates
        try {
            store.persist()
        } catch (error) {
            store.templates = previous
            throw error
        }
        emit({ type: 'state' })
    })
    handle('shortcuts', () => {
        const result: { label: string; accelerator: string }[] = []
        const walk = (menu: Menu) => {
            for (const item of menu.items) {
                if (item.id && item.accelerator)
                    result.push({ label: item.label, accelerator: item.accelerator })
                if (item.submenu) walk(item.submenu)
            }
        }
        const menu = Menu.getApplicationMenu()
        if (menu) walk(menu)
        return result
    })
    handle('menu:state', (value) => updateMenu(menuStateSchema.parse(value)))
    handle('project', (input) => {
        const action = projectActionSchema.parse(input)
        const result = projects.mutate(action)
        if (action.kind !== 'tabs') emit({ type: 'state' })
        return result
    })
    handle('project:export', async (id) => {
        const value = projects.export(z.string().uuid().parse(id))
        const { canceled, filePath } = await dialog.showSaveDialog(window!, {
            title: 'Export Project Configuration',
            defaultPath: 'Fluxy Project.json',
            filters: [{ name: 'Project Configuration', extensions: ['json'] }]
        })
        if (canceled || !filePath) return null
        await writeFile(filePath, JSON.stringify(value, null, 2), { mode: 0o600 })
        return filePath
    })
    handle('project:import', async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(window!, {
            title: 'Import Project Configuration',
            properties: ['openFile'],
            filters: [{ name: 'Project Configuration', extensions: ['json'] }]
        })
        if (canceled) return null
        if ((await stat(filePaths[0])).size > 2 * 1024 * 1024)
            throw new Error('Project configuration exceeds 2 MB')
        const result = projects.import(JSON.parse(await readFile(filePaths[0], 'utf8')))
        emit({ type: 'state' })
        return result
    })
    handle('transaction:delete', (input) => {
        const ids = z.array(z.string().uuid()).min(1).max(50000).parse(input)
        const removing = new Set(ids)
        const favorites = [...store.favorites.values()].filter((t) => !removing.has(t.id))
        store.write('favorites.json', favorites)
        store.favorites = new Map(favorites.map((t) => [t.id, t]))
        for (const id of ids) events.delete(id)
        engine.deleteTransactions(ids)
    })
    handle('openapi:export', async (inputFormat, inputIDs) => {
        const format = z.enum(['yaml', 'html']).parse(inputFormat)
        const ids = new Set(z.array(z.string().uuid()).min(1).max(50000).parse(inputIDs))
        const items = [...new Map([...store.favorites, ...engine.transactions]).values()].filter(
            (t) => ids.has(t.id)
        )
        const document = toOpenAPI(items)
        const { canceled, filePath } = await dialog.showSaveDialog(window!, {
            title: 'Export OpenAPI',
            defaultPath: `Fluxy API.${format}`,
            filters: [
                {
                    name: format === 'yaml' ? 'OpenAPI YAML' : 'API Reference HTML',
                    extensions: [format]
                }
            ]
        })
        if (canceled || !filePath) return null
        await writeFile(filePath, format === 'yaml' ? toYAML(document) : openAPIHTML(document), {
            mode: 0o600
        })
        return filePath
    })
    handle(
        'debug:info',
        () =>
            `Fluxy ${app.getVersion()} / ${process.platform} ${process.arch} / Electron ${process.versions.electron} / Node ${process.versions.node}`
    )
    handle('link', async (input) => {
        const link = z.enum(['homepage', 'repository', 'docs', 'issues', 'changelog']).parse(input)
        const base = 'https://github.com/fqix/fluxy'
        const paths = {
            homepage: '',
            repository: '',
            docs: '/blob/main/ELECTRON.md',
            issues: '/issues',
            changelog: '/blob/main/CHANGELOG.md'
        }
        await shell.openExternal(base + paths[link])
    })
    handle('certificate:export-format', async (input, passwordInput) => {
        const format = z.enum(['pem', 'der', 'key', 'p12']).parse(input)
        const password = z
            .string()
            .max(1024)
            .parse(passwordInput ?? '')
        if (format === 'key' || format === 'p12') {
            if (format === 'p12' && !password)
                throw new Error('Enter a password to encrypt the P12 archive')
            const answer = await dialog.showMessageBox(window!, {
                type: 'warning',
                message: 'Export the root CA private key?',
                detail: 'Anyone with this private key can create certificates trusted by your configured clients. Keep the exported file private.',
                buttons: ['Cancel', 'Export'],
                defaultId: 0,
                cancelId: 0
            })
            if (answer.response !== 1) return null
        }
        await ensureCertificate(join(store.directory, 'certificates'))
        const { canceled, filePath } = await dialog.showSaveDialog(window!, {
            defaultPath: `Fluxy-Root-CA.${format}`,
            filters: [{ name: 'Root Certificate', extensions: [format] }]
        })
        if (canceled || !filePath) return null
        const pem = await readFile(engine.certificatePath)
        let payload = format === 'der' ? new X509Certificate(pem).raw : pem
        if (format === 'key' || format === 'p12') {
            const key =
                customCertificates.rootIdentity()?.key ??
                (await readFile(join(store.directory, 'certificates/keys/ca.private.key')))
            if (format === 'key') payload = Buffer.from(key)
            else {
                const archive = forge.pkcs12.toPkcs12Asn1(
                    forge.pki.privateKeyFromPem(key.toString()),
                    [forge.pki.certificateFromPem(pem.toString())],
                    password,
                    { algorithm: 'aes256' }
                )
                payload = Buffer.from(forge.asn1.toDer(archive).getBytes(), 'binary')
            }
        }
        await writePrivateFile(filePath, payload)
        return filePath
    })
    handle('certificate:reset', async () => {
        if (engine.running || tun.status.state !== 'stopped')
            throw new Error('Stop capture before resetting certificates')
        const answer = await dialog.showMessageBox(window!, {
            type: 'warning',
            message: 'Reset Fluxy Certificates?',
            detail: 'This removes this Electron installation’s root CA, its System trust, and cached host certificates, and all imported identities. Custom CA trust installed separately is preserved. Clients must trust the newly generated CA afterward.',
            buttons: ['Cancel', 'Reset'],
            defaultId: 0,
            cancelId: 0
        })
        if (answer.response !== 1) return false
        const status = await certificateStatus(join(store.directory, 'certificates'))
        if (status.error) throw new Error(status.error)
        if (status.generated && supportedHelperPlatform())
            await helper.removeCertificate(
                new X509Certificate(
                    await readFile(join(store.directory, 'certificates/certs/ca.pem'))
                ).raw
            )
        customCertificates.clear()
        await rm(join(store.directory, 'custom-root.pem'), { force: true })
        await rm(join(store.directory, 'certificates'), { recursive: true, force: true })
        emit({ type: 'state' })
        return true
    })
    handle('helper:reset', async () => {
        const answer = await dialog.showMessageBox(window!, {
            type: 'warning',
            message: 'Force Reset Fluxy Helper?',
            detail: 'Capture will stop and the helper service will be reinstalled. Your operating system may ask for administrator authorization.',
            buttons: ['Cancel', 'Reset'],
            defaultId: 0,
            cancelId: 0
        })
        if (answer.response !== 1) return false
        await capture.stop()
        await helper.repair()
        emit({ type: 'state' })
        return true
    })
    handle('helper:status', () => helper.refresh())
    handle('helper:install', () => helper.install())
    handle('helper:uninstall', async () => {
        if (!supportedHelperPlatform()) throw new Error('Unsupported helper platform')
        const answer = await dialog.showMessageBox(window!, {
            type: 'warning',
            message: 'Uninstall Fluxy Helper?',
            detail: 'Capture will stop. This removes the Electron helper service, its installed programs and pairing information. Certificates, saved traffic and preferences are kept. Your operating system will request administrator authorization. TUN requires installing the helper again.',
            buttons: ['Cancel', 'Uninstall'],
            defaultId: 0,
            cancelId: 0
        })
        if (answer.response !== 1) return false
        await capture.stop()
        await helper.uninstall()
        emit({ type: 'state' })
        return true
    })
    handle('snapshot', (): Snapshot => ({
        customCertificates: customCertificates.list(),
        customCertificateError: customCertificates.error,
        update: updater.state,
        projectsInitialized: projects.initialized,
        templates: store.templates,
        projects: projects.catalog,
        projectError: projects.error,
        helper: helper.status,
        tun: tun.status,
        networkInterfaces: Object.entries(networkInterfaces())
            .filter(([, addresses]) => addresses?.some((address) => !address.internal))
            .map(([name]) => name),
        settings: store.settings,
        rules: store.rules,
        scripts: store.scripts,
        transactions: [...engine.transactions.values()],
        favorites: [...store.favorites.values()],
        running: engine.running,
        recording: engine.recording,
        logs: engine.logs,
        sessions: store.sessions(),
        certificatePath: engine.certificatePath,
        systemProxy: systemProxy.enabled,
        mcpConfig: JSON.stringify(
            {
                mcpServers: {
                    fluxy: {
                        command: process.execPath,
                        args: [join(__dirname, 'mcp-bridge.js'), store.directory],
                        env: { ELECTRON_RUN_AS_NODE: '1' }
                    }
                }
            },
            null,
            2
        )
    }))
    handle('start', startCapture)
    handle('stop', async () => {
        await capture.stop()
        emit({ type: 'state' })
    })
    handle('record', (value) => {
        engine.recording = z.boolean().parse(value)
        emit({ type: 'state' })
    })
    handle('clear', () => {
        events.clear()
        engine.clear()
    })
    handle('settings', async (value) => {
        const next = settingsSchema.parse(value)
        if (
            JSON.stringify(next.protobufSchemas) !==
                JSON.stringify(store.settings.protobufSchemas) ||
            next.protobufType !== store.settings.protobufType
        ) {
            const compiled = compileProtobuf(next.protobufSchemas)
            if (next.protobufType && !compiled.types.includes(next.protobufType))
                throw new Error('Select a message type from the configured schemas')
        }
        if (
            (capture.busy ||
                engine.running ||
                ['starting', 'running', 'stopping'].includes(tun.status.state)) &&
            (next.captureMode !== store.settings.captureMode ||
                next.autoSystemProxy !== store.settings.autoSystemProxy ||
                JSON.stringify(next.tun) !== JSON.stringify(store.settings.tun) ||
                JSON.stringify(next.upstream) !== JSON.stringify(store.settings.upstream))
        )
            throw new Error('Stop capture before changing transport or upstream settings')
        if (next.upstream.enabled) {
            const target = new URL(next.upstream.url)
            if (
                ![
                    'http:',
                    'https:',
                    'socks:',
                    'socks5:',
                    'socks5h:',
                    'pac+http:',
                    'pac+https:'
                ].includes(target.protocol)
            )
                throw new Error('Use HTTP, HTTPS, SOCKS5, or pac+https upstream URLs')
            if (
                ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) &&
                Number(target.port) === next.port
            )
                throw new Error('The upstream proxy cannot point to Fluxy itself')
        }
        if (
            (capture.busy || engine.running) &&
            (next.port !== store.settings.port ||
                next.localhostOnly !== store.settings.localhostOnly)
        )
            throw new Error('Stop the proxy before changing its listen address or port')
        const previous = store.settings
        if (next.mcpPort === next.port && next.mcpEnabled)
            throw new Error('MCP and proxy must use different ports')
        if (next.mcpPort !== previous.mcpPort || next.mcpEnabled !== previous.mcpEnabled) {
            await mcp.stop()
            store.settings = next
            try {
                if (next.mcpEnabled) await mcp.start()
            } catch (error) {
                store.settings = previous
                if (previous.mcpEnabled) await mcp.start()
                throw error
            }
        }
        store.settings = next
        store.persist()
        nativeTheme.themeSource = next.theme
        emit({ type: 'state' })
    })
    handle('rules', (value) => {
        const next = z.array(ruleSchema).max(1000).parse(value)
        if (next.filter((r) => r.kind === 'networkCondition' && r.enabled).length > 1)
            throw new Error('Only one network condition can be enabled at a time')
        for (const rule of next) {
            if (
                ['breakpoint', 'networkCondition'].includes(rule.kind) &&
                rule.matchType === 'regex'
            ) {
                try {
                    new RegExp(rule.pattern)
                } catch {
                    throw new Error('Invalid breakpoint regular expression')
                }
            }
            if (['requestHeader', 'responseHeader'].includes(rule.kind)) {
                if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rule.header) || /[\r\n]/.test(rule.value))
                    throw new Error('Invalid HTTP header')
                if (
                    ['content-length', 'transfer-encoding', 'connection'].includes(
                        rule.header.toLowerCase()
                    )
                )
                    throw new Error('Framing headers cannot be changed by a header rule')
            }
            if (rule.kind === 'mapRemote') composeSchema.shape.url.parse(rule.value)
        }
        store.rules = next
        store.persist()
        emit({ type: 'state' })
    })
    handle('scripts', (value) => {
        store.scripts = z.array(scriptSchema).max(100).parse(value)
        store.persist()
        emit({ type: 'state' })
    })
    handle('compose', (value) => engine.compose(composeSchema.parse(value)))
    handle('transaction', (id, value) => {
        const validated = z.string().uuid().parse(id)
        const t = engine.transactions.get(validated) ?? store.favorites.get(validated)
        if (!t) throw new Error('Request no longer exists')
        Object.assign(
            t,
            z
                .object({
                    pinned: z.boolean().optional(),
                    saved: z.boolean().optional(),
                    note: z.string().max(100000).optional(),
                    highlight: highlightSchema.optional()
                })
                .parse(value)
        )
        engine.publish(t)
        store.updateFavorite(t)
        emit({ type: 'state' })
    })
    handle('breakpoints:apply', (edits) =>
        engine.applyBreakpoints(
            z
                .array(z.object({ id: z.string().uuid(), edit: breakpointEditSchema }))
                .max(1000)
                .parse(edits)
        )
    )
    handle('breakpoints', (action) =>
        engine.resolveAllBreakpoints(z.enum(['continue', 'abort']).parse(action))
    )
    handle('breakpoint', (id, action, edit) =>
        engine.resolveBreakpoint(
            z.string().uuid().parse(id),
            z.enum(['continue', 'abort']).parse(action),
            edit ? breakpointEditSchema.parse(edit) : undefined
        )
    )
    handle('session:save', (name) => {
        store.saveSession(z.string().trim().min(1).max(200).parse(name), [
            ...engine.transactions.values()
        ])
        emit({ type: 'state' })
    })
    handle('session:load', (id) => {
        events.clear()
        engine.replace(store.loadSession(z.string().uuid().parse(id)))
    })
    handle('session:delete', (id) => {
        store.deleteSession(z.string().uuid().parse(id))
        emit({ type: 'state' })
    })
    handle('har:export', async (ids) => {
        const selected =
            ids === undefined
                ? undefined
                : new Set(z.array(z.string().uuid()).max(50000).parse(ids))
        const { canceled, filePath } = await dialog.showSaveDialog(window!, {
            title: 'Export Session',
            defaultPath: 'Fluxy Session.har',
            filters: [{ name: 'HTTP Archive', extensions: ['har'] }]
        })
        if (canceled || !filePath) return null
        await writeFile(
            filePath,
            JSON.stringify(
                toHAR(
                    [
                        ...new Map([
                            ...comparisons.pairs
                                .flatMap((p) => [p.left, p.right])
                                .map((t) => [t.id, t] as const),
                            ...engine.transactions,
                            ...store.favorites
                        ]).values()
                    ].filter((t) =>
                        !selected ? engine.transactions.has(t.id) : selected.has(t.id)
                    )
                ),
                null,
                2
            ),
            { mode: 0o600 }
        )
        return filePath
    })
    handle('har:import', async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(window!, {
            title: 'Import Session',
            properties: ['openFile'],
            filters: [{ name: 'HTTP Archive', extensions: ['har', 'json'] }]
        })
        if (canceled) return
        if ((await stat(filePaths[0])).size > 100 * 1024 * 1024)
            throw new Error('Import file exceeds 100 MB')
        const items = fromHAR(JSON.parse(await readFile(filePaths[0], 'utf8')))
        const { response } = await dialog.showMessageBox(window!, {
            type: 'question',
            message: `Import ${items.length} requests?`,
            detail: 'This replaces the current traffic list. Save the current session first if needed.',
            buttons: ['Import', 'Cancel'],
            defaultId: 1,
            cancelId: 1
        })
        if (response === 0) {
            events.clear()
            engine.replace(items)
        }
    })
    handle('certificate:status', () =>
        certificateStatus(
            join(store.directory, 'certificates'),
            customCertificates.publicRootPath()
        )
    )
    handle('certificate:generate', async () => {
        await ensureCertificate(join(store.directory, 'certificates'))
        return certificateStatus(
            join(store.directory, 'certificates'),
            customCertificates.publicRootPath()
        )
    })
    handle('certificate:export', async () => {
        await ensureCertificate(join(store.directory, 'certificates'))
        const { canceled, filePath } = await dialog.showSaveDialog(window!, {
            defaultPath: 'Fluxy-Electron-Root-CA.pem',
            filters: [{ name: 'Certificate', extensions: ['pem', 'crt'] }]
        })
        if (canceled || !filePath) return null
        await copyFile(engine.certificatePath, filePath)
        return filePath
    })
    handle('certificate:trust', async () => {
        if (customCertificates.rootIdentity())
            throw new Error(
                'A custom root issuer is active. Export its public certificate and trust it through your operating system certificate manager.'
            )
        if (!supportedHelperPlatform())
            throw new Error(
                'Export the certificate and import it into your operating system trust store.'
            )
        await ensureCertificate(join(store.directory, 'certificates'))
        const der = new X509Certificate(await readFile(engine.certificatePath)).raw
        await helper.installCertificate(der)
        const status = await certificateStatus(
            join(store.directory, 'certificates'),
            customCertificates.publicRootPath()
        )
        if (!status.trusted)
            throw new Error(
                status.error || 'CA installation finished, but system trust verification failed'
            )
        engine.log(
            'Root CA installed and trusted through Helper Tool. Restart clients before capturing HTTPS.'
        )
        return true
    })
    handle('systemProxy', async (enabled) => {
        const value = z.boolean().parse(enabled)
        await capture.setSystemProxy(value)
        emit({ type: 'state' })
    })
    handle('chooseFile', async () => {
        const result = await dialog.showOpenDialog(window!, { properties: ['openFile'] })
        return result.canceled ? null : result.filePaths[0]
    })
    handle('copy', (text) =>
        clipboard.writeText(
            z
                .string()
                .max(16 * 1024 * 1024)
                .parse(text)
        )
    )
}
async function createWindow() {
    window = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1000,
        minHeight: 640,
        title: 'Fluxy',
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#202024' : '#ffffff',
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 18, y: 20 },
        icon: join(__dirname, '../../resources/icon.png'),
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true
        }
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) =>
        callback(false)
    )
    window.webContents.session.setPermissionCheckHandler(() => false)
    if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged)
        await window.loadURL(process.env.ELECTRON_RENDERER_URL)
    else await window.loadFile(join(__dirname, '../renderer/index.html'))
    window.on('closed', () => {
        window = null
    })
}
if (!app.requestSingleInstanceLock()) app.quit()
else {
    app.on('second-instance', () => {
        window?.show()
        window?.focus()
    })
    const startup = app
        .whenReady()
        .then(async () => {
            if (quitting) return
            store = new Store(app.getPath('userData'))
            projects = new ProjectStore(store)
            customCertificates = new CustomCertificates(
                store,
                (value) => {
                    if (!safeStorage.isEncryptionAvailable())
                        throw new Error('Platform credential encryption is unavailable')
                    return safeStorage.encryptString(value).toString('base64')
                },
                (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
            )
            engine = new ProxyEngine(store, emit)
            engine.customCertificates = customCertificates
            const corePath = app.isPackaged
                ? join(process.resourcesPath, 'core', executableName('fluxy-core'))
                : join(app.getAppPath(), 'build', 'electron-core', executableName('fluxy-core'))
            helper = new HelperService(
                store.directory,
                app.isPackaged
                    ? join(process.resourcesPath, 'helper', executableName('fluxy-helper'))
                    : join(
                          app.getAppPath(),
                          'build',
                          'electron-helper',
                          executableName('fluxy-helper')
                      ),
                corePath,
                () => emit({ type: 'state' })
            )
            await helper.refresh()
            if (quitting) return
            tun = new TunService(store, engine, corePath, () => emit({ type: 'state' }), helper)
            await tun.checkCore()
            if (quitting) return
            engine.scriptRunner = (script, message) => scripts.run(script, message)
            systemProxy = new SystemProxy(store)
            capture = new CaptureController(() => store.settings, engine, tun, systemProxy)
            mcp = new MCPService(store, engine)
            await rm(join(store.directory, 'assistant-key.json'), { force: true }).catch(() =>
                engine.log('Could not remove the legacy assistant credential file', 'warn')
            )
            if (quitting) return
            comparisons = new DiffWorkspace(store)
            updater = new UpdateService(
                autoUpdater,
                app.getVersion(),
                app.isPackaged && (process.platform !== 'linux' || !!process.env.APPIMAGE),
                () => emit({ type: 'state' }),
                () => {
                    quitting = false
                    cleanupComplete = false
                }
            )
            updater.schedule(() => store.settings.updates)
            nativeTheme.themeSource = store.settings.theme
            registerIPC()
            Menu.setApplicationMenu(
                Menu.buildFromTemplate(
                    buildMenuTemplate(initialMenuState, command, process.platform, app.isPackaged)
                )
            )
            try {
                await systemProxy.recover()
            } catch (error) {
                engine.log(`System proxy recovery failed: ${String(error)}`, 'error')
            }
            if (quitting) return
            await createWindow()
            if (quitting) return
            store.loadFavorites()
            emit({ type: 'state' })
            if (store.warning) engine.log(store.warning, 'warn')
            if (store.settings.mcpEnabled)
                await mcp.start().catch((error) => engine.log(String(error), 'error'))
            if (quitting) return
            if (store.settings.autoStart && store.settings.captureMode !== 'tun')
                await startCapture().catch((error) => engine.log(String(error), 'error'))
            if (quitting) return
            app.on('activate', () => {
                if (!quitting && !window) void createWindow()
            })
        })
        .catch((error) => {
            if (quitting) return
            dialog.showErrorBox('Fluxy failed to start', String(error))
            app.quit()
        })
    app.on('window-all-closed', () => app.quit())
    app.on('before-quit', (event) => {
        if (cleanupComplete) return
        event.preventDefault()
        if (quitting) return
        quitting = true
        updater?.close()
        void (async () => {
            // Let the current initialization await settle, then stop only the
            // services that exist. Startup guards prevent later services/windows
            // from being created after this quit request.
            await startup
            await capture?.settled()
            const errors = await stopServices({ tun, helper, systemProxy, engine, mcp, scripts })
            if (errors.length) dialog.showErrorBox('Fluxy cleanup failed', errors.join('\n'))
            cleanupComplete = true
            app.quit()
        })()
    })
}
