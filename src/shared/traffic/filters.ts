import { z } from 'zod'
import type { Transaction } from '../contracts/model'

export const filterFields = {
    url: 'URL',
    contains: 'Contains',
    host: 'Host',
    domain: 'Domain',
    path: 'Path',
    method: 'Method',
    statusCode: 'Status Code',
    requestHeader: 'Request Header',
    responseHeader: 'Response Header',
    requestBody: 'Request Body',
    responseBody: 'Response Body',
    queryString: 'Query String',
    cookies: 'Cookies',
    clientApp: 'Client/App',
    contentType: 'Content Type',
    comment: 'Note',
    color: 'Color'
} as const
export const filterOperators = {
    contains: 'Contains',
    is: 'Is',
    startsWith: 'Starts With',
    endsWith: 'Ends With',
    doesNotContain: 'Does Not Contain',
    notEqual: 'Is Not',
    regex: 'Regex'
} as const
export const filterRuleSchema = z.object({
    id: z.string().uuid(),
    isEnabled: z.boolean().default(true),
    connector: z.enum(['and', 'or']).default('and'),
    field: z
        .enum(
            Object.keys(filterFields) as [
                keyof typeof filterFields,
                ...Array<keyof typeof filterFields>
            ]
        )
        .default('url'),
    operator: z
        .enum(
            Object.keys(filterOperators) as [
                keyof typeof filterOperators,
                ...Array<keyof typeof filterOperators>
            ]
        )
        .default('contains'),
    value: z.string().max(10000).default('')
})
export type FilterRule = z.infer<typeof filterRuleSchema>
export function activeFilterRules(rules: FilterRule[], visible = true) {
    return visible ? rules.filter((r) => r.isEnabled && r.value.trim()) : []
}
export function filterError(rule: FilterRule) {
    if (rule.operator !== 'regex' || !rule.value) return ''
    try {
        new RegExp(rule.value, 'i')
        return ''
    } catch {
        return 'Invalid regular expression'
    }
}
function bodyText(text: string, base64?: string) {
    let bytes: Uint8Array
    try {
        bytes = base64
            ? Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
            : new TextEncoder().encode(text)
    } catch {
        return ''
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 1000000))
    } catch {
        return ''
    }
}
export function headerPairs(t: Transaction, side: 'request' | 'response'): [string, string][] {
    const entries = side === 'request' ? t.requestHeaderEntries : t.responseHeaderEntries
    return (
        entries?.map((h) => [h.name, h.value]) ??
        Object.entries(side === 'request' ? t.requestHeaders : t.responseHeaders)
    )
}
export function filterFieldValue(t: Transaction, field: FilterRule['field']): string {
    switch (field) {
        case 'url':
        case 'contains':
            return t.url
        case 'host':
        case 'domain':
            return t.host
        case 'path':
            return new URL(t.url).pathname
        case 'method':
            return t.method
        case 'statusCode':
            return t.status ? String(t.status) : ''
        case 'requestHeader':
            return headerPairs(t, 'request')
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n')
        case 'responseHeader':
            return headerPairs(t, 'response')
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n')
        case 'requestBody':
            return bodyText(t.requestBody, t.requestBase64)
        case 'responseBody':
            return bodyText(t.responseBody, t.responseBase64)
        case 'queryString':
            return new URL(t.url).search.slice(1)
        case 'clientApp':
            return t.client
        case 'contentType': {
            const values = headerPairs(t, 'request')
                .concat(headerPairs(t, 'response'))
                .filter(([name]) => name.toLowerCase() === 'content-type')
                .map(([, value]) => value)
            const normalized = values.map((value) => {
                const type = value.split(';')[0].trim().toLowerCase()
                if (type === 'application/json' || type.endsWith('+json')) return 'json'
                if (type === 'text/xml' || type === 'application/xml' || type.endsWith('+xml'))
                    return 'xml'
                if (type === 'text/html') return 'html'
                if (type.startsWith('image/')) return 'image'
                if (type === 'application/x-www-form-urlencoded') return 'form'
                if (type === 'multipart/form-data') return 'multipartForm'
                if (
                    /^application\/(grpc(?:-web)?(?:\+.*)?|(?:x-)?protobuf)$/.test(type) ||
                    type.endsWith('+proto')
                )
                    return 'protobuf'
                return type.startsWith('text/') ? 'text' : 'unknown'
            })
            return [...normalized, ...values].join('\n')
        }
        case 'comment':
            return t.note
        case 'color':
            return t.highlight ?? ''
        case 'cookies': {
            const url = new URL(t.url),
                path = url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/'
            const cookie = (value: string) => {
                const parts = value.split(';').map((v) => v.trim())
                if (!parts[0].includes('=')) return ''
                const attribute = (name: string) =>
                    parts
                        .slice(1)
                        .find((v) => v.toLowerCase().startsWith(name + '='))
                        ?.slice(name.length + 1)
                const domain = attribute('domain')
                return `${parts[0]}; domain=${domain ? (domain.startsWith('.') ? domain : '.' + domain) : url.hostname}; path=${attribute('path') || path}`
            }
            // Foundation treats the request Cookie field as a Set-Cookie field too.
            return [
                t.requestHeaders.cookie ?? '',
                ...headerPairs(t, 'response')
                    .filter(([k]) => k.toLowerCase() === 'set-cookie')
                    .flatMap(([, v]) => v.split('\n'))
            ]
                .map(cookie)
                .filter(Boolean)
                .join('\n')
        }
    }
}
export function compileFilter(rules: FilterRule[]) {
    const compiled = activeFilterRules(rules).map((rule) => ({
        rule,
        regex:
            rule.operator === 'regex'
                ? (() => {
                      try {
                          return new RegExp(rule.value, 'i')
                      } catch {
                          return null
                      }
                  })()
                : null
    }))
    return (value: (field: FilterRule['field']) => string) => {
        let result = true
        compiled.forEach(({ rule, regex }, index) => {
            const original = value(rule.field),
                text = original.toLowerCase(),
                target = rule.value.toLowerCase()
            let matched: boolean
            switch (rule.operator) {
                case 'contains':
                    matched = text.includes(target)
                    break
                case 'is':
                    matched = text === target
                    break
                case 'startsWith':
                    matched = text.startsWith(target)
                    break
                case 'endsWith':
                    matched = text.endsWith(target)
                    break
                case 'doesNotContain':
                    matched = !text.includes(target)
                    break
                case 'notEqual':
                    matched = text !== target
                    break
                case 'regex':
                    matched = regex?.test(original) ?? false
                    break
            }
            result =
                index === 0
                    ? matched
                    : rule.connector === 'and'
                      ? result && matched
                      : result || matched
        })
        return result
    }
}
