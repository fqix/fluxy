import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-expect-error Release publishing is a dependency-free Node script.
import { publishRelease } from '../../tools/publish-electron-release.mjs'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
afterEach(() => vi.resetAllMocks())

it('creates update feed tags from the release commit SHA', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-publish-'))
    const commit = 'a'.repeat(40)
    const execute = vi.mocked(execFileSync)
    execute.mockImplementation((file, args) => {
        if (file === 'git') return `${commit}\n`
        if (args?.[1] === 'view') throw new Error('Release does not exist')
        return ''
    })
    try {
        await writeFile(
            join(directory, 'release-plan.json'),
            JSON.stringify({
                version: '0.1.0',
                arch: 'arm64',
                versioned: [],
                stable: [],
                manifest: 'latest.yml'
            })
        )
        await writeFile(join(directory, 'latest.yml'), 'version: 0.1.0\n')
        publishRelease([directory], 'v0.1.0')
        expect(execute).toHaveBeenCalledWith('git', ['rev-parse', '--verify', 'v0.1.0^{commit}'], {
            encoding: 'utf8'
        })
        expect(execute).toHaveBeenCalledWith(
            'gh',
            expect.arrayContaining(['create', 'electron-stable-arm64', '--target', commit]),
            { stdio: 'inherit' }
        )
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})
