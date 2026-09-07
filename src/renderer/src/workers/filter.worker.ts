import { compileFilter, filterFieldValue, type FilterRule } from '@shared/traffic/filters'
import type { Transaction } from '@shared/contracts/model'
self.onmessage = ({ data }: MessageEvent<{ transactions: Transaction[]; rules: FilterRule[] }>) => {
    const matches = compileFilter(data.rules)
    self.postMessage(
        data.transactions
            .filter((t) => matches((field) => filterFieldValue(t, field)))
            .map((t) => t.id)
    )
}
