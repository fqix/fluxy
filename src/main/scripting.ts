import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { composeSchema, type Script, type ScriptMessage } from '../shared/model'

const messageSchema = z.object({
    url: composeSchema.shape.url,
    method: composeSchema.shape.method,
    headers: composeSchema.shape.headers,
    body: z.string().max(2 * 1024 * 1024),
    status: z.number().int().min(100).max(599).optional()
})
export class ScriptRunner {
    private active = new Set<BrowserWindow>()
    private isolated?: Electron.Session
    async run(script: Script, message: ScriptMessage): Promise<ScriptMessage> {
        if (this.active.size >= 4) throw new Error('Scripting concurrency limit reached')
        const isolated = (this.isolated ??= session.fromPartition(`fluxy-script-${randomUUID()}`))
        isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
        isolated.setPermissionCheckHandler(() => false)
        const page =
            'data:text/html,' +
            encodeURIComponent(
                "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; frame-src 'none'\">"
            )
        isolated.webRequest.onBeforeRequest((details, callback) =>
            callback({ cancel: details.url !== page })
        )
        isolated.on('will-download', (event) => event.preventDefault())
        const sandbox = new BrowserWindow({
            show: false,
            webPreferences: {
                session: isolated,
                sandbox: true,
                nodeIntegration: false,
                contextIsolation: true,
                webSecurity: true,
                backgroundThrottling: false
            }
        })
        this.active.add(sandbox)
        sandbox.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        sandbox.webContents.on('will-navigate', (event) => event.preventDefault())
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            await sandbox.loadURL(page)
            const execution = sandbox.webContents.executeJavaScript(`(async () => {
        const serialize = JSON.stringify.bind(JSON), parse = JSON.parse.bind(JSON);
        const input = parse(${JSON.stringify(JSON.stringify(message))});
        const action = new Function('request', 'response', ${JSON.stringify(script.code)});
        const output = await action(${script.phase === 'request' ? 'input, undefined' : 'undefined, input'});
        const result = serialize(output === undefined ? input : output);
        if (result.length > 4194304) throw new Error('Script output exceeds 4 MB');
        return result;
      })()`)
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    sandbox.webContents.forcefullyCrashRenderer()
                    reject(new Error('Script exceeded its 5 second execution limit'))
                }, 5000)
            })
            const result = messageSchema.parse(JSON.parse(await Promise.race([execution, timeout])))
            // Framing is always computed by the proxy, never supplied by script code.
            for (const name of Object.keys(result.headers))
                if (
                    [
                        'content-length',
                        'transfer-encoding',
                        'connection',
                        'proxy-authorization'
                    ].includes(name.toLowerCase())
                )
                    delete result.headers[name]
            return result
        } finally {
            if (timer) clearTimeout(timer)
            this.active.delete(sandbox)
            if (!sandbox.isDestroyed()) sandbox.destroy()
        }
    }
    close() {
        for (const window of this.active)
            if (!window.isDestroyed()) {
                window.webContents.forcefullyCrashRenderer()
                window.destroy()
            }
        this.active.clear()
    }
}
