#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'third_party/sing-box')
const PATCHES = join(ROOT, 'third_party/patches/sing-box')
const PIN = JSON.parse(readFileSync(join(PATCHES, 'pin.json'), 'utf8'))
const COMMAND = './cmd/sing-box'
const GO = process.env.FLUXY_GO || 'go'
const ARCHES = { arm64: 'arm64', x86_64: 'amd64' }
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const run = (command, args, options = {}) =>
    execFileSync(command, args, { stdio: 'inherit', ...options })
const output = (command, args, options = {}) =>
    execFileSync(command, args, {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        ...options
    }).trim()

// Collect notices from compiled packages and their parent directories once each.
function collectNotices(cwd, env, tags) {
    const compiled = output(
        GO,
        ['list', '-mod=readonly', '-tags=' + tags.join(','), '-deps', '-json', COMMAND],
        { cwd, env }
    )
        .split(/^}$/m)
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .map((chunk) => JSON.parse(chunk + '}'))
    const goroot = output(GO, ['env', 'GOROOT'], { env })
    const modules = {}
    const notices = new Map()
    const visited = new Set()
    const add = (module, root, path) =>
        notices.set(
            module + '/' + relative(root, path).split(sep).join('/'),
            readFileSync(path, 'utf8')
        )
    for (const entry of compiled) {
        const module = entry.Module || { Path: 'Go', Dir: goroot }
        const root = resolve((module.Replace || module).Dir)
        modules[module.Path] = module.Version || 'local'
        let folder = resolve(entry.Dir)
        while ((folder === root || folder.startsWith(root + sep)) && !visited.has(folder)) {
            visited.add(folder)
            for (const item of readdirSync(folder, { withFileTypes: true })) {
                if (item.isFile() && /^(LICENSE|COPYING|NOTICE|COPYRIGHT|PATENTS)/i.test(item.name))
                    add(module.Path, root, join(folder, item.name))
                if (folder === root && item.isDirectory() && item.name === 'LICENSES') {
                    for (const license of readdirSync(join(root, item.name), {
                        withFileTypes: true,
                        recursive: true
                    }))
                        if (license.isFile())
                            add(module.Path, root, join(license.parentPath, license.name))
                }
            }
            if (folder === root) break
            folder = dirname(folder)
        }
    }
    const goLicense = existsSync(join(goroot, 'LICENSE'))
        ? join(goroot, 'LICENSE')
        : join(dirname(goroot), 'LICENSE')
    notices.set('Go/LICENSE', readFileSync(goLicense, 'utf8'))
    const text =
        `Fluxy transport: sing-box ${PIN.version}
Source: https://github.com/SagerNet/sing-box/tree/${PIN.revision}
Build profile and local modifications: third_party/patches/sing-box in the Fluxy source repository.
Applied patches and their checksums are listed in the build manifest.

` +
        [...notices]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, content]) => `===== ${name} =====\n${content}\n\n`)
            .join('')
    return { text, modules }
}

function main() {
    const { values } = parseArgs({
        options: {
            platform: {
                type: 'string',
                default: process.platform === 'win32' ? 'windows' : process.platform
            },
            arch: { type: 'string', multiple: true },
            output: { type: 'string' },
            test: { type: 'boolean', default: false },
            race: { type: 'boolean', default: false }
        }
    })
    const target = values.platform
    const arches = [
        ...new Set(values.arch ?? [process.arch === 'x64' ? 'x86_64' : process.arch])
    ].sort()
    if (
        !['darwin', 'linux', 'windows'].includes(target) ||
        arches.some((arch) => !Object.hasOwn(ARCHES, arch))
    )
        throw new Error('Unsupported target: ' + target + '/' + arches.join(','))
    if (arches.length > 1 && (target !== 'darwin' || process.platform !== 'darwin'))
        throw new Error('Universal builds require a macOS host and target')
    if (
        values.test &&
        (arches.length !== 1 ||
            ARCHES[arches[0]] !== (process.arch === 'x64' ? 'amd64' : process.arch) ||
            target !== (process.platform === 'win32' ? 'windows' : process.platform))
    )
        throw new Error('Tests require the native host target')
    const destination = resolve(
        values.output ?? join(ROOT, 'build/sing-box' + (target === 'windows' ? '.exe' : ''))
    )
    const revision = output('git', ['-C', SOURCE, 'rev-parse', 'HEAD'])
    if (revision !== PIN.revision)
        throw new Error(`sing-box revision mismatch: expected ${PIN.revision}, got ${revision}`)
    const patches = readdirSync(PATCHES)
        .filter((name) => name.endsWith('.patch'))
        .sort()
        .map((name) => ({ name, sha256: sha256(join(PATCHES, name)) }))
    mkdirSync(join(ROOT, 'build'), { recursive: true })
    const work = mkdtempSync(join(ROOT, 'build/sing-box-'))
    const cwd = join(work, 'source')
    mkdirSync(cwd)
    const envFor = (arch) => ({
        ...process.env,
        GOTOOLCHAIN: PIN.toolchain,
        GOWORK: 'off',
        GOENV: 'off',
        GOFLAGS: '',
        GOOS: target,
        GOARCH: ARCHES[arch],
        CGO_ENABLED: values.race ? '1' : '0'
    })
    try {
        // Export committed source so local submodule edits remain untouched.
        const archive = execFileSync('git', ['-C', SOURCE, 'archive', PIN.revision], {
            maxBuffer: 256 * 1024 * 1024
        })
        run('tar', ['-xf', '-', '-C', cwd], {
            input: archive,
            stdio: ['pipe', 'inherit', 'inherit']
        })
        for (const patch of patches)
            run('git', ['apply', '--whitespace=nowarn', join(PATCHES, patch.name)], {
                cwd,
                env: { ...process.env, GIT_CEILING_DIRECTORIES: work }
            })
        const tags = readFileSync(join(cwd, 'release/DEFAULT_BUILD_TAGS_OTHERS'), 'utf8')
            .trim()
            .split(',')
        const ldflags = readFileSync(join(cwd, 'release/LDFLAGS'), 'utf8').trim()
        const flags = ['-mod=readonly', '-tags=' + tags.join(',')]
        if (values.test) {
            const race = target !== 'windows' || arches[0] !== 'arm64'
            const env = { ...envFor(arches[0]), CGO_ENABLED: race ? '1' : '0' }
            run(
                GO,
                [
                    'test',
                    ...(race ? ['-race'] : []),
                    ...flags,
                    '-ldflags=' + ldflags,
                    './service/fluxyinspector/...',
                    './include',
                    COMMAND
                ],
                {
                    cwd,
                    env
                }
            )
            run(GO, ['vet', ...flags, './service/fluxyinspector/...', './include', COMMAND], {
                cwd,
                env
            })
            return
        }
        const slices = arches.map((arch) => {
            const binary = join(work, 'sing-box-' + arch)
            console.log(`Building sing-box ${PIN.version} for ${target}/${arch}`)
            run(
                GO,
                [
                    'build',
                    ...(values.race ? ['-race'] : []),
                    ...flags,
                    '-trimpath',
                    '-buildvcs=false',
                    '-ldflags=' +
                        ldflags +
                        ' -s -w -buildid= -X github.com/sagernet/sing-box/constant.Version=' +
                        PIN.version,
                    '-o',
                    binary,
                    COMMAND
                ],
                { cwd, env: envFor(arch) }
            )
            return binary
        })
        const binary = join(work, 'sing-box')
        if (slices.length === 1) copyFileSync(slices[0], binary)
        else run('xcrun', ['lipo', '-create', ...slices, '-output', binary])
        const { text, modules } = collectNotices(cwd, envFor(arches[0]), tags)
        mkdirSync(dirname(destination), { recursive: true })
        copyFileSync(binary, destination)
        chmodSync(destination, 0o755)
        writeFileSync(destination + '.licenses.txt', text)
        writeFileSync(
            destination + '.build.json',
            JSON.stringify(
                {
                    ...PIN,
                    platform: target,
                    architectures: arches,
                    profile: 'fluxy-transport',
                    tags,
                    patches,
                    modules,
                    unsignedSHA256: sha256(binary)
                },
                null,
                2
            ) + '\n'
        )
        console.log('sing-box ready: ' + destination)
    } finally {
        rmSync(work, { recursive: true, force: true })
    }
}

try {
    main()
} catch (error) {
    console.error('error: ' + error.message)
    process.exitCode = 1
}
