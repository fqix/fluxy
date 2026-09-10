import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { certificateScript, uninstallationScript } from '../../src/main/system/helper'

it
    .skipIf(process.platform === 'win32')
    .each(
        (['install', 'remove'] as const).flatMap((action) =>
            ['success', 'removal failure', 'checksum mismatch'].map((outcome) => ({
                action,
                outcome
            }))
        )
    )(
    'runs $action independently with a verified bundled program: $outcome',
    async ({ action, outcome }) => {
        const directory = await mkdtemp(join(tmpdir(), 'fluxy-uninstall-test-'))
        try {
            const binary = join(directory, 'helper')
            const received = join(directory, 'certificate.json')
            const finished = join(directory, 'uninstalled')
            const source = `#!/bin/sh\n[ "$1" = ${action === 'install' ? 'trust-ca-privileged' : 'remove-ca-privileged'} ] || exit 19\ncat > '${received}'\nexit ${outcome === 'removal failure' ? 23 : 0}\n`
            await writeFile(binary, source, { mode: 0o700 })
            const der = Buffer.from('public certificate fixture')
            const script = certificateScript(action, {
                certificate: der,
                helperPath: binary,
                helperSHA256:
                    outcome === 'checksum mismatch'
                        ? 'a'.repeat(64)
                        : createHash('sha256').update(source).digest('hex')
            })
            expect(script).not.toContain('launchctl')
            expect(script).not.toContain('/Library/PrivilegedHelperTools')
            // Use isolated fixtures; no system stores are touched.
            const prefix = script.replace(
                '/private/tmp/fluxy-certificate.XXXXXX',
                join(directory, 'staged.XXXXXX')
            )
            const run = promisify(execFile)('/bin/sh', [
                '-c',
                prefix + `\nprintf done > '${finished}'`
            ])
            if (outcome === 'success') {
                await run
                expect(JSON.parse(await readFile(received, 'utf8'))).toBe(der.toString('base64'))
                expect(await readFile(finished, 'utf8')).toBe('done')
            } else {
                await expect(run).rejects.toThrow()
                await expect(readFile(finished)).rejects.toThrow()
                if (outcome === 'checksum mismatch')
                    await expect(readFile(received)).rejects.toThrow()
            }
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    }
)

it
    .skipIf(process.platform === 'win32')
    .each(['delayed exit', 'service stuck', 'process stuck', 'bootout failed', 'already removed'])(
    'waits for launchd and the helper process before deleting files: %s',
    async (scenario) => {
        const directory = await mkdtemp(join(tmpdir(), 'fluxy-launchd-test-'))
        try {
            const launchctl = join(directory, 'launchctl')
            const kill = join(directory, 'kill')
            const remove = join(directory, 'remove')
            await writeFile(
                launchctl,
                `#!/bin/sh
cd '${directory}'
if [ "$1" = bootout ]; then
    [ '${scenario}' != 'bootout failed' ] || exit 5
    touch requested
    exit 0
fi
if [ '${scenario}' = 'already removed' ]; then touch unloaded exited; exit 113; fi
if [ -f requested ]; then
    count=$(cat polls 2>/dev/null || echo 0)
    count=$((count + 1))
    echo "$count" > polls
    if [ "$count" -ge 3 ] && [ '${scenario}' != 'service stuck' ]; then
        touch unloaded
        exit 113
    fi
fi
printf 'pid = 987654\n'
`,
                { mode: 0o700 }
            )
            await writeFile(
                kill,
                `#!/bin/sh
cd '${directory}'
[ -f unloaded ] || exit 90
count=$(cat process-polls 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > process-polls
if [ "$count" -ge 3 ] && [ '${scenario}' != 'process stuck' ]; then touch exited; exit 1; fi
exit 0
`,
                { mode: 0o700 }
            )
            await writeFile(
                remove,
                `#!/bin/sh
cd '${directory}'
[ -f unloaded ] && [ -f exited ] || exit 91
printf '%s\n' "$*" >> deleted
`,
                { mode: 0o700 }
            )
            // All service/process mutations and deletes are intercepted by temporary
            // executables. Even a failed assertion cannot touch the installed helper.
            const script = uninstallationScript()
                .replaceAll('/bin/launchctl', `'${launchctl}'`)
                .replaceAll('/bin/kill', `'${kill}'`)
                .replaceAll('/bin/rm', `'${remove}'`)
                .replaceAll('/bin/sleep 1', '/usr/bin/true')
            const result = promisify(execFile)('/bin/sh', ['-c', script])
            if (scenario === 'delayed exit' || scenario === 'already removed') {
                await result
                expect(await readFile(join(directory, 'deleted'), 'utf8')).toContain(
                    'PrivilegedHelperTools'
                )
                if (scenario === 'delayed exit') {
                    expect(Number(await readFile(join(directory, 'polls'), 'utf8'))).toBe(3)
                    expect(Number(await readFile(join(directory, 'process-polls'), 'utf8'))).toBe(3)
                }
            } else {
                await expect(result).rejects.toThrow('uninstall stopped')
                await expect(readFile(join(directory, 'deleted'))).rejects.toThrow()
            }
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    }
)
