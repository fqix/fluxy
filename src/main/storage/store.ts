import {
    mkdirSync,
    readFileSync,
    writeFileSync,
    renameSync,
    existsSync,
    readdirSync,
    unlinkSync,
    chmodSync,
    copyFileSync
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
    breakpointTemplateSchema,
    MAX_CAPTURE_ENTRIES,
    type BreakpointTemplate,
    settingsSchema,
    ruleSchema,
    transactionSchema,
    scriptSchema,
    type Script,
    type Settings,
    type Rule,
    type Transaction,
    type SessionSummary
} from '../../shared/contracts/model'
import { z } from 'zod'

export class Store {
    settings: Settings = settingsSchema.parse({})
    rules: Rule[] = []
    scripts: Script[] = []
    templates: BreakpointTemplate[] = []
    warning?: string
    favorites = new Map<string, Transaction>()
    constructor(readonly directory: string) {
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        mkdirSync(join(directory, 'sessions'), { recursive: true, mode: 0o700 })
        const file = join(directory, 'preferences.json')
        if (existsSync(file)) {
            try {
                const document = JSON.parse(readFileSync(file, 'utf8'))
                // Older versions allowed up to 50,000 live requests. Preserve the
                // remaining preferences when applying the new capture ceiling.
                if (
                    typeof document.settings?.maxEntries === 'number' &&
                    document.settings.maxEntries > MAX_CAPTURE_ENTRIES
                )
                    document.settings.maxEntries = MAX_CAPTURE_ENTRIES
                const value = z
                    .object({
                        settings: settingsSchema,
                        rules: z.array(ruleSchema),
                        scripts: z.array(scriptSchema).default([]),
                        templates: z.array(breakpointTemplateSchema).max(500).default([])
                    })
                    .parse(document)
                this.settings = value.settings
                this.rules = value.rules
                this.scripts = value.scripts
                this.templates = value.templates
                if (document.settings && 'assistant' in document.settings) {
                    delete document.settings.assistant
                    this.write('preferences.json', document)
                }
            } catch {
                copyFileSync(file, file + `.corrupt-${Date.now()}`)
                this.warning =
                    'Preferences could not be read. A copy of the original file was kept; defaults are active.'
            }
        }
    }
    loadFavorites() {
        const path = join(this.directory, 'favorites.json')
        if (!existsSync(path)) return
        try {
            for (const t of z
                .array(transactionSchema)
                .max(50000)
                .parse(JSON.parse(readFileSync(path, 'utf8'))))
                this.favorites.set(t.id, t)
        } catch {
            this.warning = 'Saved favorites could not be read. The original file is preserved.'
        }
    }
    updateFavorite(t: Transaction) {
        if (t.pinned || t.saved || t.note) this.favorites.set(t.id, t)
        else this.favorites.delete(t.id)
        this.write('favorites.json', [...this.favorites.values()])
    }
    write(name: string, value: unknown) {
        const target = join(this.directory, name)
        const temporary = target + '.tmp'
        writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
        chmodSync(temporary, 0o600)
        renameSync(temporary, target)
    }
    persist() {
        this.write('preferences.json', {
            settings: this.settings,
            rules: this.rules,
            scripts: this.scripts,
            templates: this.templates
        })
    }
    saveSession(name: string, items: Transaction[]) {
        const summary: SessionSummary = {
            id: randomUUID(),
            name,
            createdAt: Date.now(),
            count: items.length
        }
        this.write(`sessions/${summary.id}.json`, { ...summary, transactions: items })
    }
    sessions(): SessionSummary[] {
        return readdirSync(join(this.directory, 'sessions'))
            .filter((f) => /^[a-f0-9-]+\.json$/.test(f))
            .flatMap((f) => {
                try {
                    const { id, name, createdAt, count } = JSON.parse(
                        readFileSync(join(this.directory, 'sessions', f), 'utf8')
                    )
                    return [{ id, name, createdAt, count }]
                } catch {
                    return []
                }
            })
            .sort((a, b) => b.createdAt - a.createdAt)
    }
    loadSession(id: string): Transaction[] {
        return z
            .array(transactionSchema)
            .max(50000)
            .parse(
                JSON.parse(
                    readFileSync(
                        join(this.directory, 'sessions', `${z.string().uuid().parse(id)}.json`),
                        'utf8'
                    )
                ).transactions
            )
    }
    deleteSession(id: string) {
        unlinkSync(join(this.directory, 'sessions', `${z.string().uuid().parse(id)}.json`))
    }
}
