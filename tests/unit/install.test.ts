import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-expect-error Release preparation is a dependency-free Node script.
import { prepareRelease } from '../../tools/publish-electron-release.mjs'
const execute = promisify(execFile)
const directories: string[] = []
const temporary = async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-installer-'))
    directories.push(directory)
    return directory
}
afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    )
})

describe('published installer contract', () => {
    it.each([
        [
            'darwin',
            'mac',
            'arm64',
            [
                ['dmg', 'arm64'],
                ['zip', 'arm64']
            ],
            'latest-mac.yml'
        ],
        [
            'linux',
            'linux',
            'x64',
            [
                ['deb', 'amd64'],
                ['rpm', 'x86_64']
            ],
            'latest-linux.yml'
        ],
        [
            'linux',
            'linux',
            'arm64',
            [
                ['deb', 'arm64'],
                ['rpm', 'aarch64']
            ],
            'latest-linux-arm64.yml'
        ],
        ['win32', 'win', 'x64', [['exe', 'x64']], 'latest.yml'],
        ['win32', 'win', 'arm64', [['exe', 'arm64']], 'latest.yml']
    ] as const)(
        'prepares checksums and stable aliases for %s / %s / %s',
        async (platform, os, arch, extensions, manifest) => {
            const directory = await temporary()
            for (const [extension, packageArch] of extensions)
                await writeFile(
                    join(directory, `Fluxy-0.1.0-${os}-${packageArch}.${extension}`),
                    `fixture-${extension}`
                )
            await writeFile(join(directory, manifest), 'version: 0.1.0\n')
            const plan = prepareRelease(directory, '0.1.0', platform, arch)
            for (const [extension] of extensions) {
                const alias = `Fluxy-${os}-${arch}.${extension}`
                const data = await readFile(join(directory, alias))
                const hash = createHash('sha256').update(data).digest('hex')
                expect(await readFile(join(directory, alias + '.sha256'), 'utf8')).toBe(
                    `${hash}  ${alias}\n`
                )
                expect(plan.stable).toContain(alias)
            }
            expect(plan.manifest).toBe(manifest)
            expect(plan.versioned).toContain(`latest-${os}-${arch}.yml`)
            expect(await readFile(join(directory, `latest-${os}-${arch}.yml`), 'utf8')).toBe(
                'version: 0.1.0\n'
            )
        }
    )
    it('keeps Windows architecture metadata separate in the shared versioned release', async () => {
        const assets: string[] = []
        for (const arch of ['x64', 'arm64']) {
            const directory = await temporary()
            await writeFile(join(directory, `Fluxy-0.1.0-win-${arch}.exe`), arch)
            const metadata = `version: 0.1.0\npath: Fluxy-0.1.0-win-${arch}.exe\n`
            await writeFile(join(directory, 'latest.yml'), metadata)
            const plan = prepareRelease(directory, '0.1.0', 'win32', arch)
            assets.push(...plan.versioned)
            expect(plan.manifest).toBe('latest.yml')
            expect(await readFile(join(directory, `latest-win-${arch}.yml`), 'utf8')).toBe(metadata)
            expect(await readFile(join(directory, 'latest.yml'), 'utf8')).toBe(metadata)
        }
        expect(new Set(assets).size).toBe(assets.length)
        expect(assets).toContain('latest-win-x64.yml')
        expect(assets).toContain('latest-win-arm64.yml')
    })
    it('requires both Linux package formats and never prepares AppImage', async () => {
        const directory = await temporary()
        await writeFile(join(directory, 'Fluxy-0.1.0-linux-x64.AppImage'), 'fixture')
        expect(() => prepareRelease(directory, '0.1.0', 'linux', 'x64')).toThrow(
            'Missing release artifact'
        )
        const pkg = JSON.parse(await readFile('package.json', 'utf8'))
        expect(pkg.build.linux.target).toEqual(['deb', 'rpm'])
    })
})

describe.skipIf(process.platform === 'win32')(
    'Unix install entry point without system mutations',
    () => {
        async function fixture(
            format: 'deb' | 'rpm',
            tamper = false,
            arch: 'x64' | 'arm64' = 'x64'
        ) {
            const directory = await temporary(),
                bin = join(directory, 'bin')
            await mkdir(bin)
            const payload = 'harmless package fixture'
            await writeFile(join(directory, 'payload'), payload)
            await writeFile(
                join(directory, 'checksum'),
                createHash('sha256').update(payload).digest('hex') + '  fixture\n'
            )
            const commands = {
                uname: `#!/bin/bash\nif [ "$1" = -s ]; then echo Linux; else echo ${arch === 'arm64' ? 'aarch64' : 'x86_64'}; fi\n`,
                id: '#!/bin/bash\necho 1000\n',
                curl: `#!/bin/bash\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then destination=$2; shift 2; else url=$1; shift; fi; done\ncase "$url" in *.sha256) cp "$FIXTURE/checksum" "$destination";; *) cp "$FIXTURE/payload" "$destination"; ${tamper ? 'echo altered >> "$destination"' : ':'};; esac\n`,
                sha256sum: '#!/bin/bash\nshasum -a 256 "$@"\n',
                sudo: '#!/bin/bash\nprintf "%s\\n" "$@" > "$FIXTURE/privileged-arguments"\n',
                ...(format === 'deb'
                    ? { 'apt-get': '#!/bin/bash\nexit 0\n', dpkg: '#!/bin/bash\nexit 0\n' }
                    : { dnf: '#!/bin/bash\nexit 0\n', rpm: '#!/bin/bash\nexit 0\n' })
            }
            for (const [name, body] of Object.entries(commands))
                await writeFile(join(bin, name), body, { mode: 0o755 })
            return {
                directory,
                env: {
                    ...process.env,
                    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
                    FIXTURE: directory
                }
            }
        }
        it.each([
            ['deb', 'x64', 'amd64'],
            ['rpm', 'x64', 'x86_64'],
            ['deb', 'arm64', 'arm64'],
            ['rpm', 'arm64', 'aarch64']
        ] as const)(
            'selects and verifies %s / %s before asking the package manager to install',
            async (format, arch, packageArch) => {
                const { directory, env } = await fixture(format, false, arch)
                const { stdout } = await execute(
                    '/bin/bash',
                    ['install.sh', '--version', '0.1.0', '--format', format],
                    { env }
                )
                expect(stdout).toContain(`Fluxy-0.1.0-linux-${packageArch}.${format}`)
                const command = await readFile(join(directory, 'privileged-arguments'), 'utf8')
                expect(command).toContain('Checksum changed before installation')
                expect(command).toContain(format === 'deb' ? 'apt-get' : 'dnf')
                // Check the elevated shell's syntax, without executing package hooks or sudo.
                const script = command.slice(
                    command.indexOf('set -euo'),
                    command.indexOf('\nfluxy-install\n')
                )
                await execute('/bin/bash', ['-n', '-c', script])
            }
        )
        it('does not elevate when a download is corrupt', async () => {
            const { directory, env } = await fixture('deb', true)
            await expect(
                execute('/bin/bash', ['install.sh', '--format', 'deb'], { env })
            ).rejects.toThrow('Checksum mismatch')
            await expect(readFile(join(directory, 'privileged-arguments'))).rejects.toThrow()
        })
        it('dry-run performs no download and rejects malicious versions', async () => {
            const { directory, env } = await fixture('deb')
            const { stdout } = await execute(
                '/bin/bash',
                ['install.sh', '--dry-run', '--arch', 'arm64', '--format', 'deb'],
                { env }
            )
            expect(stdout).toContain('electron-stable-arm64/Fluxy-linux-arm64.deb')
            await expect(readFile(join(directory, 'privileged-arguments'))).rejects.toThrow()
            await expect(
                execute(
                    '/bin/bash',
                    ['install.sh', '--version', '1.0.0/../../evil', '--format', 'deb'],
                    { env }
                )
            ).rejects.toThrow('Invalid release version')
        })
    }
)
