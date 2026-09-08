import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(directory, '../..')
const platform = process.env.FLUXY_BUILD_PLATFORM || process.platform
const arch = process.env.FLUXY_BUILD_ARCH || process.arch
if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch))
    throw new Error('Unsupported proxy target')
const go = process.env.FLUXY_GO || 'go'
const race = process.env.FLUXY_PROXY_RACE === '1'
if (
    race &&
    (platform !== process.platform ||
        arch !== process.arch ||
        (platform === 'win32' && arch === 'arm64'))
)
    throw new Error('Proxy race checks require a supported native target')
const output = join(root, 'build/goproxy')
mkdirSync(output, { recursive: true })
const binary = join(output, platform === 'win32' ? 'fluxy-proxy.exe' : 'fluxy-proxy')
const env = {
    ...process.env,
    GOOS: platform === 'win32' ? 'windows' : platform,
    GOARCH: arch === 'x64' ? 'amd64' : 'arm64',
    CGO_ENABLED: race ? '1' : '0',
    GOWORK: 'off',
    GOFLAGS: ''
}
const options = { cwd: directory, env }
execFileSync(
    go,
    [
        'build',
        ...(race ? ['-race'] : []),
        '-mod=readonly',
        '-trimpath',
        '-buildvcs=false',
        '-ldflags=-s -w',
        '-o',
        binary,
        '.'
    ],
    {
        ...options,
        stdio: 'inherit'
    }
)
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const moduleVersion = readFileSync(join(directory, 'go.mod'), 'utf8').match(
    /github\.com\/elazarl\/goproxy (v\S+)/
)[1]
writeFileSync(
    join(output, 'manifest.json'),
    JSON.stringify(
        {
            version: 1,
            engine: 'goproxy',
            engineVersion: moduleVersion,
            platform,
            arch,
            binarySHA256: hash(binary),
            goModSHA256: hash(join(directory, 'go.mod')),
            goSumSHA256: hash(join(directory, 'go.sum'))
        },
        null,
        2
    ) + '\n'
)

const dependencies = new Set(
    execFileSync(
        go,
        ['list', '-mod=readonly', '-deps', '-f', '{{if .Module}}{{.Module.Path}}{{end}}', '.'],
        {
            ...options,
            encoding: 'utf8'
        }
    )
        .trim()
        .split('\n')
)
const modules = execFileSync(
    go,
    ['list', '-mod=readonly', '-m', '-f', '{{.Path}}|{{.Version}}|{{.Dir}}', 'all'],
    {
        ...options,
        encoding: 'utf8'
    }
)
    .trim()
    .split('\n')
    .map((line) => line.split('|'))
const goroot = execFileSync(go, ['env', 'GOROOT'], { ...options, encoding: 'utf8' }).trim()
const goLicense = [join(goroot, 'LICENSE'), join(dirname(goroot), 'LICENSE')].find(existsSync)
if (!goLicense) throw new Error('Missing Go toolchain license')
const licenses = ['Go\n' + readFileSync(goLicense, 'utf8')]
for (const [name, version, path] of modules) {
    if (!version || !dependencies.has(name)) continue
    const license = ['LICENSE', 'LICENSE.txt', 'LICENSE.md']
        .map((name) => join(path, name))
        .find(existsSync)
    if (!license) throw new Error(`Missing license for ${name} ${version}`)
    licenses.push(`${name} ${version}\n${readFileSync(license, 'utf8')}`)
    for (const notice of ['PATENTS', 'NOTICE']) {
        if (existsSync(join(path, notice))) licenses.push(readFileSync(join(path, notice), 'utf8'))
    }
}
writeFileSync(join(output, 'licenses.txt'), licenses.join('\n\n'))
console.log(`goproxy ${moduleVersion} built for ${platform}/${arch}`)
