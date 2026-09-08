import { describe, expect, it } from 'vitest'
import { parseProxyProcesses } from '../../src/main/tun/proxy-discovery'
import { selectFakeIPRange, fakeIPv6Range } from '../../src/main/tun/split-dns'
import { tunConfig } from '../../src/main/tun/tun-config'
import { settingsSchema, captureDomainsSchema } from '../../src/shared/contracts/model'

describe('Fake IP TUN coexistence', () => {
    it('normalizes and persists bounded DNS names while keeping old settings compatible', () => {
        expect(
            captureDomainsSchema.parse(['Example.COM.', '*.example.com', 'api.example.net'])
        ).toEqual(['example.com', 'api.example.net'])
        expect(settingsSchema.parse({ tun: { socksPort: 0 } }).tun.captureDomains).toEqual([])
        expect(() => captureDomainsSchema.parse(Array(101).fill('example.com'))).toThrow()
    })
    it.each([
        'https://example.com',
        'example.com:443',
        'example.com/path',
        'a..com',
        '-a.com',
        'a-.com',
        '127.0.0.1',
        '*',
        'com\nremove other',
        'a'.repeat(64) + '.com'
    ])('rejects invalid capture domain %s', (value) => {
        expect(() => captureDomainsSchema.parse([value])).toThrow()
    })
    it('recognizes external cores without matching Fluxy or paths containing a proxy name', () => {
        expect(
            parseProxyProcesses(`
123 /Applications/Clash Verge.app/Contents/MacOS/verge-mihomo
124 /usr/local/bin/sing-box
125 /Applications/Fluxy.app/Contents/Resources/core/fluxy-core
126 /tmp/sing-box/not-a-proxy
${process.pid} /tmp/sing-box
`)
        ).toEqual([
            { pid: 123, name: 'Mihomo' },
            { pid: 124, name: 'sing-box' }
        ])
    })
    it('avoids an existing proxy pool and LAN routes without treating default routes as ownership', () => {
        expect(selectFakeIPRange('0/1 utun1024\n128.0/1 utun1024\n198.18/16 utun1024')).toBe(
            '198.19.0.0/16'
        )
        expect(selectFakeIPRange('198.18/15 utun1024')).toBe('100.127.0.0/16')
        expect(selectFakeIPRange('198.18/15 utun1024\n100.64/10 en0')).toBe('172.30.0.0/16')
        expect(() => selectFakeIPRange('198.18/15 utun1024\n100.64/10 en0\n172.16/12 en1')).toThrow(
            'No unused'
        )
        expect(selectFakeIPRange('198.19.5.1 link#9')).toBe('100.127.0.0/16')
    })
    it('routes only owned Fake IPs and DNS, preserves native DNS until helper activation, and leaves egress unbound', () => {
        const settings = settingsSchema.parse({}).tun
        const config = tunConfig({
            settings,
            splitDNS: {
                server: '192.168.1.1',
                ipv4Range: '198.19.0.0/16',
                domains: ['fakeip.fluxy.test']
            },
            bridgePort: 18001,
            egressPort: 18002,
            password: 'test',
            interfaceName: 'utun2345',
            egressInterface: ''
        })
        expect(config.inbounds[0]).toMatchObject({
            dns_mode: 'disabled',
            route_address: ['198.19.0.0/16', fakeIPv6Range, '172.31.255.2/32']
        })
        expect(config.outbounds[0]).toEqual({ type: 'direct', tag: 'direct' })
        expect(config.route.rules[0]).toEqual({
            inbound: ['egress'],
            action: 'route',
            outbound: 'direct'
        })
        expect(config.route.rules[1]).toEqual({
            inbound: ['capture'],
            port: 53,
            action: 'hijack-dns'
        })
        expect(config.dns.servers[0]).toEqual({ type: 'udp', tag: 'local', server: '192.168.1.1' })
        expect(config.dns.rules?.[0]).toMatchObject({ domain_suffix: ['fakeip.fluxy.test'] })
        expect(settings.socksPort).toBe(0)
    })
})
