import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)
export function tunInterfaceName(number: number, platform = process.platform) {
    return `${platform === 'darwin' ? 'utun' : 'fluxy'}${number}`
}
export async function routeInterface(
    destination: string,
    platform = process.platform
): Promise<string> {
    // Only fixed probes from TunService are accepted; never interpolate settings into a shell.
    if (!['default', '1.1.1.1', '198.18.0.1'].includes(destination))
        throw new Error('Invalid route probe')
    if (platform === 'linux') {
        const { stdout } = await execute(
            'ip',
            ['-j', 'route', 'get', destination === 'default' ? '8.8.8.8' : destination],
            { timeout: 5000 }
        )
        const name = JSON.parse(stdout)?.[0]?.dev
        if (typeof name === 'string' && name) return name
    } else if (platform === 'win32') {
        const address = destination === 'default' ? '8.8.8.8' : destination
        const { stdout } = await execute(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `$ErrorActionPreference='Stop'; (Find-NetRoute -RemoteIPAddress '${address}' | Select-Object -First 1 -ExpandProperty InterfaceAlias) | ConvertTo-Json -Compress`
            ],
            { timeout: 10000, windowsHide: true }
        )
        const name = JSON.parse(stdout)
        if (typeof name === 'string' && name) return name
    } else if (platform === 'darwin') {
        const { stdout } = await execute('/sbin/route', ['-n', 'get', destination], {
            timeout: 5000
        })
        const name = stdout.match(/interface:\s*(\S+)/)?.[1]
        if (name) return name
    }
    throw new Error(`Cannot resolve the route to ${destination}`)
}
