import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, readdir, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { writePrivateFile } from '../../src/main/private-files'
import { terminalEnvironment } from '../../src/shared/setup'
import { Store } from '../../src/main/store'
import { ProjectStore } from '../../src/main/projects'
import { CustomCertificates } from '../../src/main/custom-certificates'
import { ensureCertificate } from '../../src/main/certificates'
import { compileProtobuf, decodeProtobuf } from '../../src/main/protobuf'
import { GistService } from '../../src/main/gist'
import { fromHAR, toHAR } from '../../src/shared/har'
import { toOpenAPI, toYAML, openAPIHTML } from '../../src/shared/openapi'
import { parseBreakpointMessage } from '../../src/shared/breakpoints'
let directory: string
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fluxy-parity-'))
})
afterEach(async () => {
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
})
function transaction() {
    return fromHAR({
        log: {
            entries: [
                {
                    startedDateTime: new Date().toISOString(),
                    request: {
                        method: 'POST',
                        url: 'https://user:secret@example.com/api?token=private&q=value',
                        headers: [
                            { name: 'content-type', value: 'application/json' },
                            { name: 'authorization', value: 'Bearer secret' }
                        ],
                        postData: { text: '{"password":"sensitive","count":2}' }
                    },
                    response: {
                        status: 201,
                        headers: [{ name: 'content-type', value: 'application/json' }],
                        content: { text: '{"id":42}' }
                    }
                }
            ]
        }
    })[0]
}
describe('project catalog', () => {
    it('persists independent tab configurations and protects the final project', () => {
        const store = new Store(directory),
            projects = new ProjectStore(store)
        const first = projects.catalog.projects[0]
        expect(() => projects.mutate({ kind: 'delete', id: first.id })).toThrow('final')
        projects.mutate({ kind: 'create', name: 'API' })
        const active = projects.catalog.activeID
        projects.mutate({
            kind: 'tabs',
            id: first.id,
            activeTabID: first.tabs[0].id,
            tabs: [{ ...first.tabs[0], query: 'POST', advanced: true, method: 'POST' }]
        })
        expect(projects.catalog.activeID).toBe(active)
        expect(new ProjectStore(store).catalog).toEqual(projects.catalog)
        expect(() => projects.mutate({ kind: 'create', name: 'api' })).toThrow('already exists')
        const portable = projects.export(first.id)
        expect(JSON.stringify(portable)).not.toContain(first.tabs[0].id)
        projects.import(portable)
        const copy = projects.catalog.projects.at(-1)!
        expect(copy.name).toBe('Default (2)')
        expect(copy.tabs[0].id).not.toBe(first.tabs[0].id)
        expect(copy.tabs[0].query).toBe('POST')
        expect(copy.tabs[0].isClosable).toBe(false)
    })
    it('preserves corrupt catalogs and backs them up on explicit repair', async () => {
        const store = new Store(directory)
        await writeFile(join(directory, 'projects.json'), '{broken')
        const projects = new ProjectStore(store)
        expect(projects.error).toBeTruthy()
        expect(() => projects.mutate({ kind: 'create', name: 'API' })).toThrow('Repair')
        expect(await readFile(join(directory, 'projects.json'), 'utf8')).toBe('{broken')
        projects.mutate({ kind: 'repair' })
        const backup = (await readdir(directory)).find((f) => f.startsWith('projects.json.backup'))!
        expect(await readFile(join(directory, backup), 'utf8')).toBe('{broken')
        expect(new ProjectStore(store).error).toBeUndefined()
    })
    it('does not update memory when persistence fails', () => {
        const store = new Store(directory),
            projects = new ProjectStore(store)
        const before = structuredClone(projects.catalog)
        vi.spyOn(store, 'write').mockImplementation(() => {
            throw new Error('disk full')
        })
        expect(() => projects.mutate({ kind: 'create', name: 'API' })).toThrow('disk full')
        expect(projects.catalog).toEqual(before)
    })
})
describe('exports and breakpoint messages', () => {
    it('infers OpenAPI schemas without credentials or sample values and escapes HTML', () => {
        const t = transaction()
        t.statusMessage = '<script>alert(1)</script>'
        const spec = toOpenAPI([t])
        expect(
            spec.paths['/api'].post.requestBody.content['application/json'].schema.properties.count
        ).toEqual({ type: 'integer' })
        const yaml = toYAML(spec)
        expect(yaml).toContain('"openapi": "3.0.3"')
        expect(yaml).not.toContain('Bearer secret')
        expect(yaml).not.toContain('sensitive')
        expect(yaml).not.toContain('user:secret')
        expect(openAPIHTML(spec)).not.toContain('<script>')
        expect(openAPIHTML(spec)).toContain('&lt;script&gt;')
        expect(() => toOpenAPI([{ ...t, method: 'CONNECT' }])).toThrow('HTTP')
    })
    it('round trips highlights and binary requests through HAR', () => {
        const t = { ...transaction(), highlight: 'purple' as const, requestBase64: 'AAEC' }
        const copy = fromHAR(toHAR([t]))[0]
        expect(copy.highlight).toBe('purple')
        expect(copy.requestBase64).toBe('AAEC')
    })
    it('parses edited messages, preserves duplicate headers and rejects injection', () => {
        expect(
            parseBreakpointMessage(
                'POST /changed HTTP/1.1\r\nHost: localhost:8000\r\n\r\nhello',
                'request'
            )
        ).toMatchObject({ url: 'https://localhost:8000/changed', method: 'POST', body: 'hello' })
        expect(
            parseBreakpointMessage(
                'HTTP/1.1 202 Accepted\nContent-Type: text/plain\n\nchanged',
                'response'
            )
        ).toMatchObject({ status: 202, body: 'changed' })
        expect(
            parseBreakpointMessage('HTTP/1.1 200 OK\nX: a\nx: b\n\n', 'response').headerEntries
        ).toEqual([
            { name: 'x', value: 'a' },
            { name: 'x', value: 'b' }
        ])
        expect(() =>
            parseBreakpointMessage('HTTP/1.1 200 OK\nX: bad\rinjected\n\n', 'response')
        ).toThrow()
    })
})
describe('reviewed gist publishing', () => {
    it('publishes exactly the frozen redacted review once', async () => {
        const request = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(JSON.stringify({ html_url: 'https://gist.github.com/user/123' }), {
                status: 201
            })
        )
        const gist = new GistService(request),
            t = transaction(),
            review = gist.review([t])
        expect(review.content).not.toContain('Bearer secret')
        expect(review.content).not.toContain('sensitive')
        t.requestBody = 'changed after review'
        const input = {
            reviewID: review.id,
            token: 'github_pat_test',
            description: 'Test',
            public: false
        }
        await expect(gist.publish(input)).resolves.toContain('gist.github.com')
        const sent = JSON.parse(request.mock.calls[0][1]!.body as string)
        expect(sent.files['fluxy.har'].content).toBe(review.content)
        expect(sent.public).toBe(false)
        await expect(gist.publish(input)).rejects.toThrow('expired')
        expect(request).toHaveBeenCalledTimes(1)
    })
    it('rejects expired reviews before network access', async () => {
        const request = vi.fn<typeof fetch>(),
            gist = new GistService(request),
            review = gist.review([transaction()])
        const now = Date.now()
        vi.spyOn(Date, 'now').mockReturnValue(now + 301000)
        await expect(
            gist.publish({ reviewID: review.id, token: 'test', description: '', public: false })
        ).rejects.toThrow('expired')
        expect(request).not.toHaveBeenCalled()
    })
})
it('decodes protobuf and gzip gRPC frames, rejects incomplete data', () => {
    const schemas = [
        {
            source: 'syntax="proto3"; package api; message Item { string name = 1; int64 count = 2; }'
        }
    ]
    const compiled = compileProtobuf(schemas)
    expect(compiled.types).toContain('api.Item')
    const type = compiled.root.lookupType('api.Item')
    const bytes = Buffer.from(type.encode(type.fromObject({ name: 'hello', count: '42' })).finish())
    expect(decodeProtobuf(schemas, 'api.Item', bytes)).toEqual({ name: 'hello', count: '42' })
    const zipped = gzipSync(bytes),
        header = Buffer.alloc(5)
    header[0] = 1
    header.writeUInt32BE(zipped.length, 1)
    expect(
        decodeProtobuf(schemas, 'api.Item', Buffer.concat([header, zipped]), true, 'gzip')
    ).toEqual([{ name: 'hello', count: '42' }])
    expect(() => decodeProtobuf(schemas, 'api.Item', header, true, 'gzip')).toThrow('Truncated')
})
it('persists encrypted certificate identities and issues matching trusted leaves', async () => {
    const rootPath = await ensureCertificate(join(directory, 'certificates'))
    const pem = await readFile(rootPath),
        key = await readFile(join(directory, 'certificates/keys/ca.private.key'))
    const store = new Store(directory)
    const encrypt = (value: string) => Buffer.from(value).toString('base64')
    const decrypt = (value: string) => Buffer.from(value, 'base64').toString()
    const certificates = new CustomCertificates(store, encrypt, decrypt)
    certificates.import({ kind: 'root', name: 'Test CA', host: '' }, [pem, key], false)
    expect(await readFile(join(directory, 'custom-certificates.json'), 'utf8')).not.toContain(
        'PRIVATE KEY'
    )
    expect(certificates.list()[0]).not.toHaveProperty('encryptedKey')
    const loaded = new CustomCertificates(store, encrypt, decrypt)
    expect(loaded.rootIdentity()?.certificate).toContain('BEGIN CERTIFICATE')
    expect(await readFile(loaded.publicRootPath()!, 'utf8')).toContain('BEGIN CERTIFICATE')
    const identity = await loaded.server('example.com')
    const leaf = new X509Certificate(identity.certificate)
    expect(leaf.checkHost('example.com')).toBe('example.com')
    expect(leaf.verify(new X509Certificate(pem).publicKey)).toBe(true)
    expect(leaf.checkPrivateKey(createPrivateKey(identity.key))).toBe(true)
    expect((await readdir(directory)).some((f) => f.startsWith('issuer-'))).toBe(false)
    const record = loaded
        .import(
            { kind: 'server', name: 'Server', host: '*.example.com' },
            [Buffer.from(identity.certificate), Buffer.from(identity.key)],
            false
        )
        .at(-1)!
    await expect(loaded.server('other.example.com')).rejects.toThrow('does not match')
    loaded.delete(record.id)
    expect(loaded.list()).toHaveLength(1)
})

it('exports private material without following existing symlinks', async () => {
    const original = join(directory, 'original'),
        target = join(directory, 'export.pem')
    await writeFile(original, 'original')
    await symlink(original, target)
    await writePrivateFile(target, 'private key')
    expect(await readFile(original, 'utf8')).toBe('original')
    expect(await readFile(target, 'utf8')).toBe('private key')
    expect((await stat(target)).mode & 0o777).toBe(0o600)
})
it('quotes terminal environment values without changing shell profiles', () => {
    const script = terminalEnvironment(6060, "/tmp/test's cert.pem")
    expect(script).toContain("export http_proxy='http://127.0.0.1:6060'")
    expect(script).toContain("export NODE_EXTRA_CA_CERTS='/tmp/test'\\''s cert.pem'")
    expect(script).not.toContain('.zshrc')
})
