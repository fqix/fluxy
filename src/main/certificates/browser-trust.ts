import { execFile } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { access, readFile, readdir, realpath, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

type Run = (args: string[]) => Promise<string>
const runCertutil: Run = async (args) => {
    try {
        const { stdout } = await promisify(execFile)('/usr/bin/certutil', args, {
            timeout: 15000,
            maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, LC_ALL: 'C' }
        })
        return stdout
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            throw new Error(
                'Browser CA setup requires certutil. Install libnss3-tools (Debian/Ubuntu) or nss-tools (Fedora), then retry Helper & Certificate Setup.'
            )
        throw error
    }
}

async function exists(path: string) {
    try {
        await access(path)
        return true
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
    }
}

// Discover only existing databases. Browsers create their own profiles; the next
// Fluxy launch picks up browsers/profiles installed since the previous launch.
export async function browserDatabases(home = homedir()): Promise<string[]> {
    const candidates = new Set<string>()
    const chromeHomes = [
        home,
        join(home, 'snap/chromium/common'),
        join(home, '.var/app/org.chromium.Chromium'),
        join(home, '.var/app/com.google.Chrome')
    ]
    for (const root of chromeHomes) {
        // Chromium prefers the legacy directory when it exists (including M146+).
        candidates.add(join(root, '.pki/nssdb'))
        candidates.add(join(root, '.local/share/pki/nssdb'))
    }
    for (const root of [
        join(home, '.mozilla/firefox'),
        join(home, '.config/mozilla/firefox'),
        join(home, 'snap/firefox/common/.mozilla/firefox'),
        join(home, '.var/app/org.mozilla.firefox/.mozilla/firefox')
    ]) {
        if (!(await exists(root))) continue
        for (const entry of await readdir(root, { withFileTypes: true }))
            if (entry.isDirectory() || entry.isSymbolicLink())
                candidates.add(join(root, entry.name))
        const ini = join(root, 'profiles.ini')
        if (await exists(ini)) {
            for (const section of (await readFile(ini, 'utf8')).split(/^\s*\[/m)) {
                if (!/^Profile[^\]]*\]/.test(section)) continue
                const path = section.match(/^Path=(.+)\r?$/m)?.[1].trim()
                if (path) candidates.add(resolve(root, path))
            }
        }
    }
    const databases = new Set<string>()
    for (const path of candidates) {
        if (await exists(join(path, 'cert9.db'))) databases.add(`sql:${await realpath(path)}`)
        else if (await exists(join(path, 'cert8.db'))) databases.add(`dbm:${await realpath(path)}`)
    }
    return [...databases].sort()
}

export class BrowserTrust {
    constructor(
        private home = homedir(),
        private platform: NodeJS.Platform = process.platform,
        private run: Run = runCertutil
    ) {}

    async update(certificate: X509Certificate, install: boolean) {
        if (this.platform !== 'linux') return
        const databases = await browserDatabases(this.home)
        if (!databases.length) return
        const temporary = await mkdtemp(join(tmpdir(), 'fluxy-browser-ca-'))
        const path = join(temporary, 'ca.pem')
        try {
            await writeFile(path, certificate.toString(), { mode: 0o600 })
            const failures: string[] = []
            for (const database of databases) {
                try {
                    await this.updateDatabase(database, certificate, path, install)
                } catch (error) {
                    failures.push(
                        `${database}: ${error instanceof Error ? error.message : String(error)}`
                    )
                }
            }
            if (failures.length)
                throw new Error(
                    `Browser CA ${install ? 'setup' : 'removal'} failed. Close the affected browser and retry.\n${failures.join('\n')}`
                )
        } finally {
            await rm(temporary, { recursive: true, force: true })
        }
    }

    private async updateDatabase(
        database: string,
        certificate: X509Certificate,
        path: string,
        install: boolean
    ) {
        const listing = await this.run(['-L', '-d', database])
        const entries = listing.split('\n').flatMap((line) => {
            const match = line.match(/^(.*?)\s+([A-Za-z]*,[A-Za-z]*,[A-Za-z]*)\s*$/)
            return match ? [{ name: match[1].trim(), trust: match[2] }] : []
        })
        let found = false
        for (const entry of entries) {
            const pem = await this.run(['-L', '-d', database, '-n', entry.name, '-a'])
            // Nicknames are not identity: also remove manual imports under other names.
            if (!new X509Certificate(pem).raw.equals(certificate.raw)) continue
            found = true
            if (!install) await this.run(['-D', '-d', database, '-n', entry.name])
            else if (!entry.trust.split(',')[0].includes('C')) {
                const [, email, object] = entry.trust.split(',')
                await this.run([
                    '-M',
                    '-d',
                    database,
                    '-n',
                    entry.name,
                    '-t',
                    `C,${email},${object}`
                ])
            }
        }
        if (install && !found) {
            const name = `Fluxy Root CA ${certificate.fingerprint256.replace(/:/g, '').toLowerCase()}`
            if (entries.some((entry) => entry.name === name))
                throw new Error('Fluxy CA nickname belongs to a different certificate')
            await this.run(['-A', '-d', database, '-n', name, '-t', 'C,,', '-i', path])
            const installed = await this.run(['-L', '-d', database, '-n', name, '-a'])
            if (!new X509Certificate(installed).raw.equals(certificate.raw))
                throw new Error('Browser CA verification failed')
        }
    }
}
