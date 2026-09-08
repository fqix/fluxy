import { execFile } from 'node:child_process'
import { getServers } from 'node:dns'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { discoverProxyProcesses } from './proxy-discovery'
import { captureDomainsSchema } from '../../shared/contracts/model'

export const fakeIPRanges = ['198.19.0.0/16', '100.127.0.0/16', '172.30.0.0/16'] as const
export const fakeIPv6Range = 'fd7a:115c:a1e0::/48'
export const splitDNSAddress = '172.31.255.2'
export interface SplitDNS {
    ipv4Range: string
    server: string
    domains: string[]
}

export function splitDNSResolverExists(interfaceName: string): Promise<boolean> {
    if (!/^utun[0-9]{4,5}$/.test(interfaceName))
        return Promise.reject(new Error('Invalid Fluxy TUN interface'))
    return new Promise((resolve, reject) => {
        const child = execFile('/usr/sbin/scutil', [], { timeout: 1000 }, (error, stdout) => {
            if (error) return reject(error)
            const output = stdout.trim()
            if (output === 'No such key') resolve(false)
            else if (output.startsWith('<dictionary>')) resolve(true)
            else reject(new Error('Cannot verify that Fluxy split DNS was restored'))
        })
        // Read only our generated service key; never remove another network service's DNS.
        child.stdin?.end(
            `show State:/Network/Service/dev.fengqi.fluxy.electron.helper.${interfaceName}/DNS\nquit\n`
        )
    })
}

export async function waitForSplitDNSRemoval(
    interfaceName: string,
    timeout = 25000,
    exists: (name: string) => Promise<boolean> = splitDNSResolverExists
) {
    const deadline = Date.now() + timeout
    while (await exists(interfaceName)) {
        if (Date.now() >= deadline)
            throw new Error('Fluxy split DNS has not been restored; keep Fluxy open and retry Stop')
        await delay(100)
    }
}

const ipv4 = (address: string) => address.split('.').reduce((n, part) => n * 256 + Number(part), 0)
export function selectFakeIPRange(routes: string): string {
    const occupied = routes.split('\n').flatMap((line) => {
        const destination = line.trim().split(/\s+/)[0]
        if (!/^\d+(?:\.\d+){0,3}(?:\/\d+)?$/.test(destination)) return []
        const [address, bits] = destination.split('/')
        const parts = address.split('.')
        const prefix = bits === undefined ? parts.length * 8 : Number(bits)
        // Default/split-default routes transport traffic; specific routes own address space.
        if (prefix < 8 || prefix > 32) return []
        const start = ipv4([...parts, ...Array(4 - parts.length).fill('0')].join('.'))
        return [{ start, end: start + 2 ** (32 - prefix) - 1 }]
    })
    const selected = fakeIPRanges.find((range) => {
        const start = ipv4(range.split('/')[0])
        return !occupied.some((route) => route.start <= start + 65535 && route.end >= start)
    })
    if (!selected) throw new Error('No unused Fake IP range is available for coexistence')
    return selected
}

export async function prepareSplitDNS(
    signal: AbortSignal,
    prompt: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>,
    captureDomains: string[] = [],
    options: { interactive?: boolean } = {}
): Promise<SplitDNS | undefined | null> {
    // Supplemental resolver ownership is implemented for macOS; other platforms keep
    // their existing explicit TUN exit until they have an equivalent DNS lifecycle.
    const domains = captureDomainsSchema.parse(captureDomains)
    if (process.platform !== 'darwin') {
        if (domains.length) throw new Error('Domain-based TUN capture currently requires macOS')
        return undefined
    }
    const processes = await discoverProxyProcesses()
    if (signal.aborted) return null
    if (!processes.length && !domains.length) return undefined
    const { stdout } = await promisify(execFile)('/usr/sbin/netstat', ['-rn', '-f', 'inet'], {
        timeout: 5000
    })
    const ipv4Range = selectFakeIPRange(stdout)
    // Snapshot before installing the supplemental resolver. Never resolve through our own DNS.
    const resolvConf = await readFile('/etc/resolv.conf', 'utf8').catch(() => '')
    const servers = [...resolvConf.matchAll(/^\s*nameserver\s+(\S+)/gm)].map((match) => match[1])
    const server = (servers.length ? servers : getServers()).find(
        (value) => isIP(value) && value !== splitDNSAddress && value !== '0.0.0.0'
    )
    if (!server) throw new Error('Cannot determine the existing DNS server for TUN coexistence')
    if (signal.aborted) return null
    // Automatic startup reuses the saved mode, but always discovers current
    // routes and DNS instead of restoring stale runtime addresses.
    if (!processes.length || options.interactive === false) return { ipv4Range, server, domains }
    const { response } = await prompt({
        type: 'info',
        title: 'TUN coexistence',
        message: `${[...new Set(processes.map((p) => p.name))].join(' / ')} is running.`,
        detail: `Fluxy will keep TUN mode and use its own sing-box DNS to allocate Fake IPs (${ipv4Range}). ${domains.length ? `Only these domains and their subdomains use Fluxy DNS: ${domains.join(', ')}.` : 'All domains use Fluxy DNS.'} Only Fluxy’s Fake IP ranges enter its TUN. Real connections keep the existing network routes. DNS is restored when capture stops.`,
        buttons: ['Start TUN', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        signal
    })
    return signal.aborted || response !== 0 ? null : { ipv4Range, server, domains }
}
