import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/main/store'
import { ProxyEngine } from '../../src/main/proxy'
import { DiffWorkspace } from '../../src/main/diff-workspace'
it('keeps bounded comparison snapshots, pins and history across restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-diff-'))
    try {
        const store = new Store(directory),
            engine = new ProxyEngine(store, () => {}),
            history = new DiffWorkspace(store)
        const a = engine.create('https://example.com/a', 'GET', {}),
            b = engine.create('https://example.com/b', 'GET', {})
        a.responseBody = 'x'.repeat(600000)
        history.record(a, b)
        const id = history.pairs[0].id
        history.change(id, { pinned: true, name: 'Pinned comparison' })
        a.responseBody = 'mutated'
        expect(history.pairs[0].left.responseBody).toHaveLength(512 * 1024)
        expect(history.pairs[0].left.truncated).toBe(true)
        for (let i = 0; i < 25; i++)
            history.record(engine.create(`https://example.com/${i}`, 'GET', {}), b)
        expect(history.pairs).toHaveLength(20)
        expect(history.pairs.find((p) => p.id === id)?.pinned).toBe(true)
        expect(new DiffWorkspace(store).pairs).toEqual(history.pairs)
        history.change(id, { remove: true })
        expect(history.pairs.find((p) => p.id === id)).toBeUndefined()
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})
