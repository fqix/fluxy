import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { X509Certificate } from 'node:crypto'
import { BrowserTrust, browserDatabases } from '../../src/main/certificates/browser-trust'
import { ensureCertificate } from '../../src/main/certificates/certificates'

let fixtures: string, ca: X509Certificate, other: X509Certificate
beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), 'fluxy-browser-fixtures-'))
    ca = new X509Certificate(await readFile(await ensureCertificate(join(fixtures, 'ca'))))
    other = new X509Certificate(await readFile(await ensureCertificate(join(fixtures, 'other'))))
})
afterAll(() => rm(fixtures, { recursive: true, force: true }))

describe('Linux browser certificate stores', () => {
    let home: string
    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'fluxy-browser-home-'))
    })
    afterEach(() => rm(home, { recursive: true, force: true }))
    async function database(path: string) {
        const full = join(home, path)
        await mkdir(full, { recursive: true })
        await writeFile(join(full, 'cert9.db'), '')
        return `sql:${await realpath(full)}`
    }
    function nss(stores: Map<string, Map<string, { pem: string; trust: string }>>) {
        return vi.fn(async (args: string[]) => {
            const store = stores.get(args[args.indexOf('-d') + 1])!
            const name = args[args.indexOf('-n') + 1]
            if (args[0] === '-L') {
                if (args.includes('-a')) return store.get(name)!.pem
                return (
                    'Certificate Nickname                                         Trust Attributes\n\n' +
                    [...store].map(([n, c]) => `${n}     ${c.trust}`).join('\n')
                )
            }
            if (args[0] === '-A')
                store.set(name, {
                    pem: await readFile(args[args.indexOf('-i') + 1], 'utf8'),
                    trust: args[args.indexOf('-t') + 1]
                })
            else if (args[0] === '-M') store.get(name)!.trust = args[args.indexOf('-t') + 1]
            else if (args[0] === '-D') store.delete(name)
            else throw new Error(`Unexpected NSS command: ${args[0]}`)
            return ''
        })
    }
    it('finds Chrome old/new stores, Firefox native/Snap/Flatpak and external registered profiles without creating profiles', async () => {
        const expected = await Promise.all(
            [
                '.pki/nssdb',
                '.local/share/pki/nssdb',
                '.mozilla/firefox/default',
                'snap/firefox/common/.mozilla/firefox/default',
                '.var/app/org.mozilla.firefox/.mozilla/firefox/default',
                'custom profile'
            ].map(database)
        )
        await writeFile(
            join(home, '.mozilla/firefox/profiles.ini'),
            `[Profile0]\nIsRelative=0\nPath=${join(home, 'custom profile')}\n`
        )
        await symlink(join(home, 'custom profile'), join(home, '.mozilla/firefox/alias'))
        expect(await browserDatabases(home)).toEqual(expected.sort())
    })
    it('adds missing trust, repairs a manual import, stays idempotent, and removes only the matching DER under every nickname', async () => {
        const db = await database('.pki/nssdb')
        const entries = new Map([
            ['manual import', { pem: ca.toString(), trust: ',C,' }],
            ['Fluxy Electron Root CA', { pem: other.toString(), trust: 'C,,' }]
        ])
        const second = await database('.mozilla/firefox/new-profile')
        const secondEntries = new Map<string, { pem: string; trust: string }>()
        const run = nss(
            new Map([
                [db, entries],
                [second, secondEntries]
            ])
        )
        const browsers = new BrowserTrust(home, 'linux', run)
        await browsers.update(ca, true)
        expect(entries.get('manual import')!.trust).toBe('C,C,')
        expect(secondEntries.size).toBe(1)
        run.mockClear()
        await browsers.update(ca, true)
        expect(run.mock.calls.every(([args]) => args[0] === '-L')).toBe(true)
        entries.set('another manual name', { pem: ca.toString(), trust: 'C,,' })
        await browsers.update(ca, false)
        expect([...entries.keys()]).toEqual(['Fluxy Electron Root CA'])
        expect(secondEntries.size).toBe(0)
        await browsers.update(ca, false)
    })
    it('attempts other profiles on a locked store and reports the failure', async () => {
        const broken = await database('.pki/nssdb')
        const good = await database('.mozilla/firefox/good')
        const entries = new Map<string, { pem: string; trust: string }>()
        const normal = nss(new Map([[good, entries]]))
        const browsers = new BrowserTrust(home, 'linux', async (args) => {
            if (args.includes(broken)) throw new Error('database locked')
            return normal(args)
        })
        await expect(browsers.update(ca, true)).rejects.toThrow('database locked')
        expect(entries.size).toBe(1)
    })
    it.each(['darwin', 'win32'] as const)(
        'does not alter browser settings on %s',
        async (platform) => {
            await database('.pki/nssdb')
            const run = vi.fn()
            const browsers = new BrowserTrust(home, platform, run)
            await browsers.update(ca, true)
            await browsers.update(ca, false)
            expect(run).not.toHaveBeenCalled()
        }
    )
})
