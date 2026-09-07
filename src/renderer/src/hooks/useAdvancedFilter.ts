import { useEffect, useRef, useState } from 'react'
import { activeFilterRules, type FilterRule } from '@shared/traffic/filters'
import type { Transaction } from '@shared/contracts/model'
export function useAdvancedFilter(
    transactions: Transaction[],
    rules: FilterRule[],
    visible: boolean
) {
    const [result, setResult] = useState<{ ids?: Set<string>; error?: string }>({})
    const key = JSON.stringify(activeFilterRules(rules, visible))
    const latest = useRef(transactions)
    latest.current = transactions
    const request = useRef<() => void>(() => {})
    useEffect(() => {
        const active = JSON.parse(key) as FilterRule[]
        if (!active.length) {
            setResult({})
            request.current = () => {}
            return
        }
        setResult({ ids: new Set() })
        const worker = new Worker(new URL('../workers/filter.worker.ts', import.meta.url), {
            type: 'module'
        })
        let busy = false,
            failed = false,
            sent: Transaction[] | undefined,
            timeout: ReturnType<typeof setTimeout>
        const fail = (error: string) => {
            failed = true
            clearTimeout(timeout)
            worker.terminate()
            setResult({ ids: new Set(), error })
        }
        const send = () => {
            if (busy || failed || sent === latest.current) return
            busy = true
            sent = latest.current
            timeout = setTimeout(
                () =>
                    fail(
                        'Filtering exceeded its time limit. Simplify the regular expression or reduce the captured data.'
                    ),
                3000
            )
            worker.postMessage({ transactions: sent, rules: active })
        }
        worker.onmessage = ({ data }: MessageEvent<string[]>) => {
            clearTimeout(timeout)
            busy = false
            setResult({ ids: new Set(data) })
            // Finish in-flight work and coalesce new traffic, so sustained capture cannot starve filtering.
            send()
        }
        worker.onerror = () => fail('Filter evaluation failed')
        request.current = send
        send()
        return () => {
            clearTimeout(timeout)
            worker.terminate()
            request.current = () => {}
        }
    }, [key])
    useEffect(() => request.current(), [transactions, key])
    return {
        ids: key === '[]' ? undefined : (result.ids ?? new Set<string>()),
        error: key === '[]' ? undefined : result.error
    }
}
