import { ProxyAgent } from 'proxy-agent'
import { matchPattern, type Settings } from '../shared/model'
import type https from 'node:https'
export function upstreamAgent(
    settings: () => Settings,
    httpsAgent?: https.Agent,
    transport?: () => string | undefined
) {
    return new ProxyAgent({
        keepAlive: true,
        httpsAgent,
        getProxyForUrl: (url: string) => {
            const forced = transport?.()
            if (forced) return forced
            const config = settings().upstream
            if (
                !config.enabled ||
                config.bypass.some((pattern) => matchPattern(pattern, new URL(url).hostname))
            )
                return ''
            return config.url
        }
    })
}
