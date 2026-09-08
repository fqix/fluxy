import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsSchema } from '../../src/shared/contracts/model'
import { Store } from '../../src/main/storage/store'
import { ProxyEngine } from '../../src/main/capture/proxy'

const directories: string[] = []
function directory() {
    const value = mkdtempSync(join(tmpdir(), 'fluxy-capture-limits-'))
    directories.push(value)
    return value
}
afterEach(() => {
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('capture limits', () => {
    it('defaults to 10,000 requests and 2 MiB per direction, with validated independent limits', () => {
        expect(settingsSchema.parse({})).toMatchObject({
            maxEntries: 10000,
            maxRequestBodyBytes: 2 * 1024 * 1024,
            maxResponseBodyBytes: 2 * 1024 * 1024
        })
        expect(
            settingsSchema.parse({ maxRequestBodyBytes: 0, maxResponseBodyBytes: 1024 })
        ).toMatchObject({
            maxRequestBodyBytes: 0,
            maxResponseBodyBytes: 1024
        })
        for (const input of [
            { maxEntries: 10001 },
            { maxEntries: 99 },
            { maxRequestBodyBytes: -1 },
            { maxResponseBodyBytes: 2 * 1024 * 1024 + 1 },
            { maxRequestBodyBytes: 1.5 }
        ])
            expect(settingsSchema.safeParse(input).success).toBe(false)
    })

    it('loads old preferences without losing settings and persists new limits in JSON', () => {
        const path = directory()
        writeFileSync(
            join(path, 'preferences.json'),
            JSON.stringify({
                settings: { maxEntries: 50000, theme: 'dark', port: 8888 },
                rules: [],
                scripts: []
            })
        )
        const store = new Store(path)
        expect(store.warning).toBeUndefined()
        expect(store.settings).toMatchObject({ maxEntries: 10000, theme: 'dark', port: 8888 })
        store.settings.maxEntries = 500
        store.settings.maxRequestBodyBytes = 4096
        store.settings.maxResponseBodyBytes = 8192
        store.persist()
        expect(new Store(path).settings).toEqual(store.settings)
        expect(
            JSON.parse(readFileSync(join(path, 'preferences.json'), 'utf8')).settings
                .maxRequestBodyBytes
        ).toBe(4096)
    })

    it('evicts oldest live records at the configured count and applies reductions immediately', () => {
        const store = new Store(directory())
        store.settings.maxEntries = 200
        const engine = new ProxyEngine(store, () => {})
        for (let i = 0; i < 220; i++) engine.create(`https://example.com/${i}`, 'GET', {})
        expect(engine.transactions.size).toBe(200)
        expect([...engine.transactions.values()][0].path).toBe('/20')
        store.settings.maxEntries = 100
        engine.enforceEntryLimit()
        expect(engine.transactions.size).toBe(100)
        expect([...engine.transactions.values()][0].path).toBe('/120')
    })
})
