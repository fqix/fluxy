import type { TunSettings } from '../../shared/contracts/model'
import { fakeIPv6Range, splitDNSAddress, type SplitDNS } from './split-dns'

export function tunConfig(options: {
    settings: TunSettings
    bridgePort: number
    egressPort: number
    password: string
    interfaceName: string
    egressInterface: string
    socksTestPort?: number
    splitDNS?: SplitDNS
}) {
    const {
        settings,
        bridgePort,
        egressPort,
        password,
        interfaceName,
        egressInterface,
        socksTestPort,
        splitDNS
    } = options
    const direct = settings.socksPort
        ? {
              type: 'socks',
              tag: 'direct',
              server: '127.0.0.1',
              server_port: settings.socksPort,
              version: '5'
          }
        : {
              type: 'direct',
              tag: 'direct',
              ...(!socksTestPort && !splitDNS ? { bind_interface: egressInterface } : {})
          }
    return {
        log: { level: 'warn', timestamp: true },
        dns: splitDNS
            ? {
                  servers: [
                      { type: 'udp', tag: 'local', server: splitDNS.server },
                      {
                          type: 'fakeip',
                          tag: 'fakeip',
                          inet4_range: splitDNS.ipv4Range,
                          inet6_range: fakeIPv6Range
                      }
                  ],
                  rules: [
                      {
                          inbound: ['capture'],
                          query_type: ['A', 'AAAA'],
                          domain_suffix: splitDNS.domains,
                          action: 'route',
                          server: 'fakeip',
                          rewrite_ttl: 1
                      }
                  ],
                  final: 'local',
                  independent_cache: true
              }
            : { servers: [{ type: 'local', tag: 'local' }] },
        inbounds: [
            socksTestPort
                ? {
                      type: 'socks',
                      tag: 'capture',
                      listen: '127.0.0.1',
                      listen_port: socksTestPort
                  }
                : {
                      type: 'tun',
                      tag: 'capture',
                      interface_name: interfaceName,
                      address: [
                          '172.31.255.1/30',
                          splitDNS ? 'fd7a:115c:a1e1::1/126' : 'fdfe:dcba:9876::1/126'
                      ],
                      mtu: 1500,
                      stack: 'gvisor',
                      auto_route: true,
                      dns_mode: 'disabled',
                      route_exclude_address: [
                          '127.0.0.0/8',
                          '::1/128',
                          '169.254.0.0/16',
                          'fe80::/10',
                          '224.0.0.0/4',
                          'ff00::/8'
                      ],
                      ...(splitDNS
                          ? {
                                route_address: [
                                    splitDNS.ipv4Range,
                                    fakeIPv6Range,
                                    `${splitDNSAddress}/32`
                                ]
                            }
                          : settings.routeCIDRs.length
                            ? { route_address: settings.routeCIDRs }
                            : {})
                  },
            {
                type: 'http',
                tag: 'egress',
                listen: '127.0.0.1',
                listen_port: egressPort,
                users: [{ username: 'fluxy', password }]
            }
        ],
        outbounds: [
            direct,
            {
                type: 'http',
                tag: 'inspect',
                server: '127.0.0.1',
                server_port: bridgePort,
                username: 'fluxy',
                password
            }
        ],
        route: {
            default_domain_resolver: 'local',
            final: 'direct',
            rules: [
                { inbound: ['egress'], action: 'route', outbound: 'direct' },
                ...(splitDNS ? [{ inbound: ['capture'], port: 53, action: 'hijack-dns' }] : []),
                { action: 'sniff', sniffer: ['http', 'tls'], timeout: '300ms' },
                { network: 'tcp', protocol: ['http', 'tls'], action: 'route', outbound: 'inspect' }
            ]
        }
    }
}
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`
