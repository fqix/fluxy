import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-expect-error Release publishing is a dependency-free Node script.
import { publishRelease } from '../../tools/publish-electron-release.mjs'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
afterEach(() => vi.resetAllMocks())

it.each([false, true])(
    'publishes all architectures only to the version release (exists: %s)',
    async (exists) => {
        const directory = await mkdtemp(join(tmpdir(), 'fluxy-publish-'))
        const execute = vi.mocked(execFileSync)
        execute.mockImplementation((_file, args) => {
            if (args?.[1] === 'view' && !exists) throw new Error('Release does not exist')
            return ''
        })
        try {
            const paths = []
            const assets = []
            for (const arch of ['x64', 'arm64']) {
                const path = join(directory, arch)
                await mkdir(path)
                paths.push(path)
                const versioned = [`Fluxy-0.1.0-win-${arch}.exe`, `latest-${arch}.yml`]
                for (const name of versioned) {
                    await writeFile(join(path, name), 'fixture')
                    assets.push(join(path, name))
                }
                await writeFile(
                    join(path, 'release-plan.json'),
                    JSON.stringify({ version: '0.1.0', arch, versioned })
                )
            }
            publishRelease(paths, 'v0.1.0')
            expect(execute.mock.calls).toHaveLength(2)
            expect(execute).toHaveBeenCalledWith('gh', ['release', 'view', 'v0.1.0'], {
                stdio: 'ignore'
            })
            expect(execute).toHaveBeenCalledWith(
                'gh',
                exists
                    ? [
                          'release',
                          'upload',
                          'v0.1.0',
                          ...assets,
                          'install.sh',
                          'install.ps1',
                          '--clobber'
                      ]
                    : [
                          'release',
                          'create',
                          'v0.1.0',
                          '--verify-tag',
                          '--title',
                          'Fluxy 0.1.0',
                          '--generate-notes',
                          ...assets,
                          'install.sh',
                          'install.ps1'
                      ],
                { stdio: 'inherit' }
            )
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    }
)
