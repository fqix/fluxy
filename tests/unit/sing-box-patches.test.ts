import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
// @ts-expect-error The build scripts are dependency-free ESM.
import { applySingBoxPatches } from '../../scripts/apply-sing-box-patches.mjs'

function fixture(run: (source: string, patches: string[]) => void, autocrlf = false) {
    const root = mkdtempSync(join(tmpdir(), 'fluxy-patch-test-'))
    const source = join(root, 'source')
    mkdirSync(source)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: source })
    try {
        git('init', '-q')
        // Temporary repositories do not inherit this project's attributes.
        // Keep fixtures independent of the runner's global Git configuration.
        git('config', 'core.autocrlf', String(autocrlf))
        git('config', 'core.eol', 'lf')
        writeFileSync(join(source, 'code.txt'), 'original\n')
        git('add', 'code.txt')
        git(
            '-c',
            'user.name=Fluxy Test',
            '-c',
            'user.email=test@example.invalid',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '-qm',
            'fixture'
        )
        const first = join(root, '0001.patch'),
            second = join(root, '0002.patch')
        writeFileSync(
            first,
            'diff --git a/code.txt b/code.txt\n--- a/code.txt\n+++ b/code.txt\n@@ -1 +1 @@\n-original\n+first\n'
        )
        writeFileSync(
            second,
            'diff --git a/code.txt b/code.txt\n--- a/code.txt\n+++ b/code.txt\n@@ -1 +1 @@\n-first\n+second\n'
        )
        run(source, [first, second])
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}

it('applies overlapping patches once and preserves later source edits', () =>
    fixture((source, patches) => {
        applySingBoxPatches(source, patches)
        expect(readFileSync(join(source, 'code.txt'), 'utf8')).toBe('second\n')
        applySingBoxPatches(source, patches)
        writeFileSync(join(source, 'code.txt'), 'local development\n')
        applySingBoxPatches(source, patches)
        expect(readFileSync(join(source, 'code.txt'), 'utf8')).toBe('local development\n')
    }))

it('preserves CRLF checkout and local edits when Git autocrlf is enabled', () =>
    fixture((source, patches) => {
        applySingBoxPatches(source, patches)
        expect(readFileSync(join(source, 'code.txt'), 'utf8')).toBe('second\r\n')
        applySingBoxPatches(source, patches)
        expect(readFileSync(join(source, 'code.txt'), 'utf8')).toBe('second\r\n')
        writeFileSync(join(source, 'code.txt'), 'local development\r\n')
        applySingBoxPatches(source, patches)
        expect(readFileSync(join(source, 'code.txt'), 'utf8')).toBe('local development\r\n')
    }, true))

it('recognizes a manually applied overlapping series without a receipt', () =>
    fixture((source, patches) => {
        writeFileSync(join(source, 'code.txt'), 'second\n')
        applySingBoxPatches(source, patches)
        expect(readFileSync(join(source, 'code.txt'), 'utf8')).toBe('second\n')
    }))

it('preflights the whole series without partially changing conflicting source', () =>
    fixture((source, patches) => {
        writeFileSync(patches[1], readFileSync(patches[1], 'utf8').replace('-first', '-conflict'))
        expect(() => applySingBoxPatches(source, patches)).toThrow('no files changed')
        expect(readFileSync(join(source, 'code.txt'), 'utf8')).toBe('original\n')
    }))

it('rejects changed patches without overwriting local source', () =>
    fixture((source, patches) => {
        applySingBoxPatches(source, patches)
        writeFileSync(patches[1], readFileSync(patches[1], 'utf8').replace('+second', '+updated'))
        expect(() => applySingBoxPatches(source, patches)).toThrow('patches or revision changed')
        expect(readFileSync(join(source, 'code.txt'), 'utf8')).toBe('second\n')
    }))
