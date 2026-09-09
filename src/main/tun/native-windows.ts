import { execFile } from 'node:child_process'
import { join } from 'node:path'

export async function nativeWindowsQuery(
    command:
        | 'certificate-status'
        | 'network-snapshot'
        | 'dns-status'
        | 'proxy-processes'
        | 'route-interface',
    input: unknown = null
): Promise<unknown> {
    const { app } = await import('electron')
    const helper = app.isPackaged
        ? join(process.resourcesPath, 'helper', 'fluxy-helper.exe')
        : join(app.getAppPath(), 'build', 'electron-helper', 'fluxy-helper.exe')
    return new Promise((resolve, reject) => {
        const child = execFile(
            helper,
            [command],
            {
                timeout: 10000,
                windowsHide: true,
                maxBuffer: 1024 * 1024
            },
            (error, stdout, stderr) => {
                if (error) return reject(new Error(stderr.trim() || error.message))
                try {
                    resolve(JSON.parse(stdout))
                } catch (error) {
                    reject(error)
                }
            }
        )
        child.stdin?.on('error', reject)
        child.stdin?.end(JSON.stringify(input))
    })
}
