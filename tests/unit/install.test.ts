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
        ['darwin', 'mac', 'arm64', ['dmg', 'zip'], 'latest-mac.yml'],
        ['linux', 'linux', 'x64', ['deb', 'rpm'], 'latest-linux.yml'],
        ['win32', 'win', 'x64', ['exe'], 'latest.yml']
    ] as const)(
        'prepares checksums and stable aliases for %s',
        async (platform, os, arch, extensions, manifest) => {
            const directory = await temporary()
            for (const extension of extensions)
                await writeFile(
                    join(
                        directory,
                        `Fluxy-0.1.0-${os}-${extension === 'deb' ? 'amd64' : extension === 'rpm' ? 'x86_64' : arch}.${extension}`
                    ),
                    `fixture-${extension}`
                )
            await writeFile(join(directory, manifest), 'version: 0.1.0\n')
            const plan = prepareRelease(directory, '0.1.0', platform, arch)
            for (const extension of extensions) {
                const alias = `Fluxy-${os}-${arch}.${extension}`
                const data = await readFile(join(directory, alias))
                const hash = createHash('sha256').update(data).digest('hex')
                expect(await readFile(join(directory, alias + '.sha256'), 'utf8')).toBe(
                    `${hash}  ${alias}\n`
                )
                expect(plan.stable).toContain(alias)
            }
            expect(plan.manifest).toBe(manifest)
        }
    )
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
        async function fixture(format: 'deb' | 'rpm', tamper = false) {
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
                uname: '#!/bin/bash\nif [ "$1" = -s ]; then echo Linux; else echo x86_64; fi\n',
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
        it.each(['deb', 'rpm'] as const)(
            'selects and verifies %s before asking the package manager to install',
            async (format) => {
                const { directory, env } = await fixture(format)
                const { stdout } = await execute(
                    '/bin/bash',
                    ['install.sh', '--version', '0.1.0', '--format', format],
                    { env }
                )
                expect(stdout).toContain(
                    `Fluxy-0.1.0-linux-${format === 'deb' ? 'amd64' : 'x86_64'}.${format}`
                )
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
