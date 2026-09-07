import { Script } from 'node:vm'
import { matchesRule, type Rule, type Headers } from '../shared/model'
const test = new Script('new RegExp(pattern).test(url)')
export function breakpointPattern(rule: Pick<Rule, 'pattern' | 'matchType' | 'includeSubpaths'>) {
    if (rule.matchType === 'regex') return rule.pattern
    const source = rule.pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
    if (rule.includeSubpaths)
        return source.endsWith('.*')
            ? source
            : /[?/]$/.test(rule.pattern)
              ? source + '.*'
              : source + '($|[/?#])'
    return source + (rule.pattern.endsWith('?') ? '$' : '($|[?#])')
}
export function matchesBreakpoint(rule: Rule, method: string, url: string, headers: Headers) {
    if (
        !rule.enabled ||
        (rule.method !== '*' && rule.method.toLowerCase() !== method.toLowerCase())
    )
        return false
    if (rule.matchHeaderName) {
        const value = Object.entries(headers).find(
            ([key]) => key.toLowerCase() === rule.matchHeaderName!.toLowerCase()
        )?.[1]
        if (value === undefined || (rule.matchHeaderValue && value !== rule.matchHeaderValue))
            return false
    }
    if (!rule.matchType || rule.matchType === 'legacy')
        return matchesRule({ ...rule, method: '*' }, method, url)
    try {
        return Boolean(
            test.runInNewContext(
                { pattern: breakpointPattern(rule), url: url.slice(0, 16000) },
                { timeout: 25 }
            )
        )
    } catch {
        return false
    }
}
