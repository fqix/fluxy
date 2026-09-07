import type { TunSettings } from '../../shared/contracts/model'

export function tunConfig(options: {
    settings: TunSettings
    bridgePort: number
    egressPort: number
    password: string
    interfaceName: string
    egressInterface: string
    socksTestPort?: number
}) {
    const {
        settings,
        bridgePort,
        egressPort,
        password,
        interfaceName,
        egressInterface,
        socksTestPort
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
              ...(!socksTestPort ? { bind_interface: egressInterface } : {})
          }
    return {
        log: { level: 'warn', timestamp: true },
        dns: { servers: [{ type: 'local', tag: 'local' }] },
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
                      address: ['172.31.255.1/30', 'fdfe:dcba:9876::1/126'],
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
                      ...(settings.routeCIDRs.length ? { route_address: settings.routeCIDRs } : {})
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
                { action: 'sniff', sniffer: ['http', 'tls'], timeout: '300ms' },
                { network: 'tcp', protocol: ['http', 'tls'], action: 'route', outbound: 'inspect' }
            ]
        }
    }
}
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`
