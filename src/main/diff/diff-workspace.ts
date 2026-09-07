import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { transactionSchema, type Transaction } from '../../shared/contracts/model'
import type { Store } from '../storage/store'
import { readFileSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
const pairSchema = z.object({
    id: z.string().uuid(),
    name: z.string().max(200),
    pinned: z.boolean(),
    createdAt: z.number(),
    left: transactionSchema,
    right: transactionSchema
})
import type { DiffPair } from '../../shared/workspace/diff'
function snapshot(t: Transaction): Transaction {
    const copy = structuredClone(t)
    // The comparison keeps the same bounded preview even after the traffic list is cleared.
    for (const side of ['request', 'response'] as const) {
        const base = side === 'request' ? 'requestBase64' : 'responseBase64',
            body = side === 'request' ? 'requestBody' : 'responseBody'
        const bytes = copy[base] ? Buffer.from(copy[base]!, 'base64') : Buffer.from(copy[body])
        if (bytes.length > 512 * 1024) {
            copy[base] = bytes.subarray(0, 512 * 1024).toString('base64')
            copy[body] = bytes.subarray(0, 512 * 1024).toString('utf8')
            copy.truncated = true
        }
    }
    copy.frames = []
    return copy
}
export class DiffWorkspace {
    pairs: DiffPair[] = []
    constructor(private store: Store) {
        const path = join(store.directory, 'diff-history.json')
        if (existsSync(path))
            try {
                this.pairs = z
                    .array(pairSchema)
                    .max(20)
                    .parse(JSON.parse(readFileSync(path, 'utf8')))
            } catch {
                copyFileSync(path, path + `.corrupt-${Date.now()}`)
            }
    }
    private save(next: DiffPair[]) {
        this.store.write('diff-history.json', next)
        this.pairs = next
        return next
    }
    record(left: Transaction, right: Transaction) {
        const old = this.pairs.find((p) => p.left.id === left.id && p.right.id === right.id)
        if (old) return this.pairs
        const next = [
            {
                id: randomUUID(),
                name: `${left.method} ${left.path} ↔ ${right.method} ${right.path}`.slice(0, 200),
                pinned: false,
                createdAt: Date.now(),
                left: snapshot(left),
                right: snapshot(right)
            },
            ...this.pairs
        ]
        while (next.length > 20) {
            const index = next.length - 1 - [...next].reverse().findIndex((p) => !p.pinned)
            next.splice(index, 1)
        }
        return this.save(next)
    }
    change(id: string, patch: { pinned?: boolean; name?: string; remove?: boolean }) {
        if (!this.pairs.some((p) => p.id === id)) throw new Error('Comparison no longer exists')
        if (patch.pinned && this.pairs.filter((p) => p.pinned).length >= 10)
            throw new Error('Keep at most 10 pinned comparisons')
        return this.save(
            patch.remove
                ? this.pairs.filter((p) => p.id !== id)
                : this.pairs.map((p) => (p.id === id ? { ...p, ...patch } : p))
        )
    }
}
