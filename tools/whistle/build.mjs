import {
    readFileSync,
    writeFileSync,
    mkdirSync,
    rmSync,
    cpSync,
    readdirSync,
    existsSync,
    readlinkSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../', import.meta.url))
const tools = join(root, 'tools/whistle')
const source = join(root, 'third_party/whistle')
const output = join(root, 'build/whistle')
const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim()
const pin = JSON.parse(readFileSync(join(tools, 'pin.json'), 'utf8'))
if (git('rev-parse', 'HEAD') !== pin.revision || git('status', '--porcelain'))
    throw new Error('Whistle submodule must be clean and match tools/whistle/pin.json')
const hash = (value) => createHash('sha256').update(value).digest('hex')
function treeHash(directory) {
    const digest = createHash('sha256')
    function visit(path, prefix = '') {
        for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name)
        )) {
            const name = `${prefix}${entry.name}`
            const file = join(path, entry.name)
            if (entry.isDirectory()) visit(file, `${name}/`)
            else
                digest
                    .update(name)
                    .update('\0')
                    .update(entry.isSymbolicLink() ? readlinkSync(file) : readFileSync(file))
                    .update('\0')
        }
    }
    visit(directory)
    return digest.digest('hex')
}
const patches = readdirSync(join(tools, 'patches'))
    .filter((name) => name.endsWith('.patch'))
    .sort()
const lock = readFileSync(join(tools, 'package-lock.json'))
const signature = hash(
    Buffer.concat([
        Buffer.from(pin.revision),
        lock,
        readFileSync(fileURLToPath(import.meta.url)),
        ...patches.map((name) => readFileSync(join(tools, 'patches', name)))
    ])
)
mkdirSync(output, { recursive: true })
const stamp = join(output, 'source.sha256')
let previous
try {
    previous = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'))
} catch {}
if (
    !existsSync(stamp) ||
    readFileSync(stamp, 'utf8') !== signature ||
    !existsSync(join(output, 'node_modules')) ||
    !existsSync(join(output, 'upstream')) ||
    previous?.sourceTreeSha256 !== treeHash(join(output, 'upstream'))
) {
    rmSync(join(output, 'upstream'), { recursive: true, force: true })
    cpSync(source, join(output, 'upstream'), {
        recursive: true,
        filter: (path) => !['.git', 'node_modules'].includes(path.split(/[\\/]/).at(-1))
    })
    for (const name of patches) {
        const patch = join(tools, 'patches', name)
        // A Windows checkout may use CRLF even though Git's source blob is LF.
        // Normalize only patched text files in the generated copy.
        for (const match of readFileSync(patch, 'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)) {
            const target = join(output, 'upstream', match[1].trim())
            writeFileSync(target, readFileSync(target, 'utf8').replace(/\r\n/g, '\n'))
        }
        execFileSync('git', ['apply', '--check', patch], {
            cwd: join(output, 'upstream'),
            stdio: 'inherit'
        })
        execFileSync('git', ['apply', patch], { cwd: join(output, 'upstream'), stdio: 'inherit' })
    }
    cpSync(join(tools, 'package.json'), join(output, 'package.json'))
    cpSync(join(tools, 'package-lock.json'), join(output, 'package-lock.json'))
    execFileSync(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
        { cwd: output, stdio: 'inherit', shell: process.platform === 'win32' }
    )
    writeFileSync(stamp, signature)
}
await build({
    entryPoints: [join(tools, 'child.ts')],
    outfile: join(output, 'child.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22'
})
writeFileSync(
    join(output, 'manifest.json'),
    JSON.stringify(
        {
            ...pin,
            lockSha256: hash(lock),
            patches: Object.fromEntries(
                patches.map((name) => [name, hash(readFileSync(join(tools, 'patches', name)))])
            ),
            sourceTreeSha256: treeHash(join(output, 'upstream')),
            dependenciesSha256: treeHash(join(output, 'node_modules')),
            childSha256: hash(readFileSync(join(output, 'child.cjs')))
        },
        null,
        2
    ) + '\n'
)
console.log(`Whistle ${pin.version} built at ${output}`)
