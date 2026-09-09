import { nativeWindowsQuery } from './native-windows'
import { execFile } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { promisify } from 'node:util'
const execute = promisify(execFile)
export function tunInterfaceName(number: number, platform = process.platform) {
    // XNU ifnet_allocate_extended rejects unit > SHRT_MAX (32767), even
    // though the utun control socket itself uses a 32-bit unit number.
    if (!Number.isInteger(number) || number < 0 || (platform === 'darwin' && number > 32767))
        throw new Error('Invalid TUN interface number')
    return `${platform === 'darwin' ? 'utun' : 'fluxy'}${number}`
}
export function unusedTunInterfaceName(occupied: Iterable<string>, platform = process.platform) {
    const minimum = 2000
    const maximum = platform === 'darwin' ? 32768 : 60000 // exclusive
    const start = randomInt(minimum, maximum)
    const names = new Set(occupied)
    for (let offset = 0; offset < maximum - minimum; offset++) {
        const number = minimum + ((start - minimum + offset) % (maximum - minimum))
        const name = tunInterfaceName(number, platform)
        if (!names.has(name)) return name
    }
    throw new Error('No unused TUN interface name is available')
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
        const name = await nativeWindowsQuery('route-interface', { destination })
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
