import { X509Certificate, createPrivateKey, randomUUID, randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { isIP } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import forge from 'node-forge'
import type { Store } from './store'
import { matchPattern } from '../shared/model'

export const certificateImportSchema = z
    .object({
        name: z.string().trim().min(1).max(100),
        kind: z.enum(['root', 'server', 'client']),
        host: z
            .string()
            .max(255)
            .regex(/^[a-zA-Z0-9.*:\[\]-]*$/),
        password: z.string().max(1024).default('')
    })
    .refine(
        (v) => v.kind === 'root' || v.host.length > 0,
        'Server and client certificates require a host pattern'
    )
const recordSchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    kind: z.enum(['root', 'server', 'client']),
    host: z.string(),
    certificate: z.string(),
    encryptedKey: z.string(),
    fingerprint: z.string(),
    expires: z.string()
})
type Record = z.infer<typeof recordSchema>
export class CustomCertificates {
    private records: Record[] = []
    private cache = new Map<string, { certificate: string; key: string }>()
    error?: string
    constructor(
        private store: Store,
        private encrypt: (value: string) => string,
        private decrypt: (value: string) => string
    ) {
        const path = join(store.directory, 'custom-certificates.json')
        if (existsSync(path)) {
            try {
                this.records = z
                    .array(recordSchema)
                    .max(100)
                    .parse(JSON.parse(readFileSync(path, 'utf8')))
            } catch {
                this.error =
                    'Custom certificate storage could not be read; the original file is preserved.'
            }
        }
    }
    list() {
        return this.records.map(
            ({ encryptedKey: _key, certificate: _certificate, ...value }) => value
        )
    }
    private commit(next: Record[]) {
        if (this.error) throw new Error(this.error)
        this.store.write('custom-certificates.json', z.array(recordSchema).max(100).parse(next))
        this.records = next
        this.cache.clear()
    }
    import(input: z.input<typeof certificateImportSchema>, data: Buffer[], p12: boolean) {
        const value = certificateImportSchema.parse(input)
        let certificate = '',
            key = ''
        if (p12) {
            const archive = forge.pkcs12.pkcs12FromAsn1(
                forge.asn1.fromDer(data[0].toString('binary')),
                value.password
            )
            for (const safe of archive.safeContents)
                for (const bag of safe.safeBags) {
                    if (bag.cert) certificate += forge.pki.certificateToPem(bag.cert)
                    if (bag.key) key = forge.pki.privateKeyToPem(bag.key)
                }
        } else {
            const text = data.map((b) => b.toString()).join('\n')
            certificate = (
                text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
            ).join('\n')
            key =
                text.match(
                    /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/
                )?.[0] ?? ''
        }
        if (!certificate || !key)
            throw new Error(
                'Import a PKCS#12 archive or select both the PEM certificate and its private key'
            )
        const privateKey = createPrivateKey({ key, passphrase: value.password || undefined })
        const chain = certificate.match(
            /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
        )!
        const leaf = chain.find((pem) => new X509Certificate(pem).checkPrivateKey(privateKey))
        if (!leaf) throw new Error('The certificate and private key do not match')
        certificate = [leaf, ...chain.filter((pem) => pem !== leaf)].join('\n')
        const parsed = new X509Certificate(certificate)
        if (!parsed.checkPrivateKey(privateKey))
            throw new Error('The certificate and private key do not match')
        if (Date.parse(parsed.validTo) <= Date.now() || Date.parse(parsed.validFrom) > Date.now())
            throw new Error('Certificate is not currently valid')
        if (value.kind === 'root' && (!parsed.ca || !parsed.verify(parsed.publicKey)))
            throw new Error('Root issuer must be a self-signed CA')
        const record: Record = {
            id: randomUUID(),
            name: value.name,
            kind: value.kind,
            host: value.host,
            certificate,
            encryptedKey: this.encrypt(
                privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
            ),
            fingerprint: parsed.fingerprint256,
            expires: parsed.validTo
        }
        this.commit([
            ...this.records.filter((r) => value.kind !== 'root' || r.kind !== 'root'),
            record
        ])
        return this.list()
    }
    delete(id: string) {
        this.commit(this.records.filter((r) => r.id !== z.string().uuid().parse(id)))
        return this.list()
    }
    clear() {
        this.commit([])
    }
    publicRootPath() {
        const root = this.records.find((r) => r.kind === 'root')
        if (!root) return undefined
        const path = join(this.store.directory, 'custom-root.pem')
        if (!existsSync(path) || readFileSync(path, 'utf8') !== root.certificate) {
            writeFileSync(path + '.tmp', root.certificate, { mode: 0o600 })
            renameSync(path + '.tmp', path)
        }
        return path
    }
    rootIdentity() {
        const root = this.records.find((r) => r.kind === 'root')
        return root
            ? { certificate: root.certificate, key: this.decrypt(root.encryptedKey) }
            : undefined
    }
    private valid(record: Record) {
        if (Date.parse(record.expires) <= Date.now())
            throw new Error('Custom certificate has expired')
        return record
    }
    client(host: string) {
        const record = this.records.find((r) => r.kind === 'client' && matchPattern(r.host, host))
        return record
            ? { cert: this.valid(record).certificate, key: this.decrypt(record.encryptedKey) }
            : undefined
    }
    hasServer(host: string) {
        return this.records.some(
            (r) => r.kind === 'root' || (r.kind === 'server' && matchPattern(r.host, host))
        )
    }
    async server(host: string) {
        const server = this.records.find((r) => r.kind === 'server' && matchPattern(r.host, host))
        if (server) {
            const cert = new X509Certificate(this.valid(server).certificate)
            const name = host.replace(/^\[|\]$/g, '')
            if (!(isIP(name) ? cert.checkIP(name) : cert.checkHost(name)))
                throw new Error('Custom server certificate does not match the requested host')
            return { certificate: server.certificate, key: this.decrypt(server.encryptedKey) }
        }
        const root = this.records.find((r) => r.kind === 'root')
        if (!root) throw new Error('No custom issuer is configured')
        this.valid(root)
        const key = `${root.id}:${host}`
        const cached = this.cache.get(key)
        if (cached) return cached
        if (!/^[a-zA-Z0-9.:-]{1,253}$/.test(host)) throw new Error('Invalid certificate hostname')
        const temp = await mkdtemp(join(this.store.directory, 'issuer-'))
        try {
            await writeFile(join(temp, 'ca.pem'), root.certificate, { mode: 0o600 })
            await writeFile(join(temp, 'ca.key'), this.decrypt(root.encryptedKey), { mode: 0o600 })
            await writeFile(
                join(temp, 'extensions.cnf'),
                `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host) ? 'IP' : 'DNS'}:${host}\n`,
                { mode: 0o600 }
            )
            const run = promisify(execFile)
            await run(
                '/usr/bin/openssl',
                [
                    'req',
                    '-new',
                    '-newkey',
                    'rsa:2048',
                    '-nodes',
                    '-keyout',
                    'leaf.key',
                    '-out',
                    'leaf.csr',
                    '-subj',
                    `/CN=${host}`
                ],
                { cwd: temp, timeout: 20000 }
            )
            await run(
                '/usr/bin/openssl',
                [
                    'x509',
                    '-req',
                    '-in',
                    'leaf.csr',
                    '-CA',
                    'ca.pem',
                    '-CAkey',
                    'ca.key',
                    '-set_serial',
                    `0x${randomBytes(16).toString('hex')}`,
                    '-out',
                    'leaf.pem',
                    '-days',
                    String(
                        Math.max(
                            1,
                            Math.min(
                                365,
                                Math.floor((Date.parse(root.expires) - Date.now()) / 86400000)
                            )
                        )
                    ),
                    '-extfile',
                    'extensions.cnf'
                ],
                { cwd: temp, timeout: 20000 }
            )
            const result = {
                certificate: (await readFile(join(temp, 'leaf.pem'), 'utf8')) + root.certificate,
                key: await readFile(join(temp, 'leaf.key'), 'utf8')
            }
            if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!)
            this.cache.set(key, result)
            return result
        } finally {
            await rm(temp, { recursive: true, force: true })
        }
    }
}
