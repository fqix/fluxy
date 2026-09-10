import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export function applySingBoxPatches(source, patches) {
    const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim()
    const revision = git('rev-parse', 'HEAD')
    const identity = JSON.stringify({
        revision,
        patches: patches.map((path) =>
            createHash('sha256').update(readFileSync(path)).digest('hex')
        )
    })
    const receipt = resolve(source, git('rev-parse', '--git-path', 'fluxy-patches.json'))
    const files = [
        ...new Set(
            patches.flatMap((path) =>
                git('apply', '--numstat', path)
                    .split('\n')
                    .filter(Boolean)
                    .map((line) => line.split('\t')[2])
            )
        )
    ]
    if (existsSync(receipt)) {
        if (readFileSync(receipt, 'utf8') !== identity)
            throw new Error(
                'sing-box patches or revision changed. Reconcile the source with the new patch series and remove ' +
                    receipt
            )
        // A checkout/reset can remove tracked patch changes while leaving the receipt.
        const dirty = git('diff', 'HEAD', '--name-only', '--', ...files)
        if (dirty && files.every((path) => existsSync(join(source, path)))) return
    }
    // Preflight in a copy of only the affected files; compilation always uses source.
    const scratch = mkdtempSync(join(tmpdir(), 'fluxy-patches-'))
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(scratch) }
    const copy = () => {
        rmSync(scratch, { recursive: true, force: true })
        mkdirSync(scratch)
        for (const file of files) {
            if (!existsSync(join(source, file))) continue
            mkdirSync(dirname(join(scratch, file)), { recursive: true })
            copyFileSync(join(source, file), join(scratch, file))
        }
    }
    const apply = (cwd, path, reverse = false) =>
        execFileSync(
            'git',
            ['apply', '--whitespace=nowarn', ...(reverse ? ['--reverse'] : []), path],
            { cwd, env, stdio: 'pipe' }
        )
    try {
        copy()
        let applied = true
        try {
            for (const patch of [...patches].reverse()) apply(scratch, patch, true)
        } catch {
            applied = false
        }
        if (!applied) {
            copy()
            try {
                for (const patch of patches) apply(scratch, patch)
            } catch (error) {
                throw new Error(
                    'sing-box patches conflict with local source; no files changed. ' +
                        (error.stderr?.toString().trim() || error.message)
                )
            }
            for (const patch of patches) apply(source, patch)
        }
        writeFileSync(receipt, identity)
        console.log(
            applied ? 'sing-box patches already applied' : 'Applied sing-box patches in ' + source
        )
    } finally {
        rmSync(scratch, { recursive: true, force: true })
    }
}
