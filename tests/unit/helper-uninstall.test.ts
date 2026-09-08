import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
    HelperService,
    HelperRPC,
    helperID,
    uninstallationScript
} from '../../src/main/system/helper'

describe.skipIf(process.platform !== 'darwin')('helper removal without system mutations', () => {
    let directory: string
    const token = 'a'.repeat(64)
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'fluxy-helper-uninstall-'))
        await writeFile(join(directory, 'helper-client.json'), JSON.stringify({ token }))
        await writeFile(join(directory, 'preferences.json'), 'saved preferences')
        await mkdir(join(directory, 'certificates'))
        await writeFile(join(directory, 'certificates', 'ca.pem'), 'saved CA')
    })
    afterEach(async () => {
        vi.restoreAllMocks()
        await rm(directory, { recursive: true, force: true })
    })
    const create = (authorize: (command: string) => Promise<void>) =>
        new HelperService(
            directory,
            '/missing/helper',
            '/missing/core',
            () => {},
            join(directory, 'helper.sock'),
            authorize
        )

    it('removes pairing only after successful authorization, even if bundled assets are missing', async () => {
        const authorize = vi.fn(async () => {
            await access(join(directory, 'helper-client.json'))
        })
        const helper = create(authorize)
        await helper.uninstall()
        expect(helper.status).toEqual({ state: 'missing' })
        await expect(access(join(directory, 'helper-client.json'))).rejects.toThrow()
        expect(await readFile(join(directory, 'preferences.json'), 'utf8')).toBe(
            'saved preferences'
        )
        expect(await readFile(join(directory, 'certificates', 'ca.pem'), 'utf8')).toBe('saved CA')
        await helper.uninstall()
        expect(authorize).toHaveBeenCalledOnce()
        helper.close()
    })

    it('keeps pairing on cancellation and permits retry', async () => {
        const authorize = vi
            .fn()
            .mockRejectedValueOnce(new Error('Authorization canceled'))
            .mockResolvedValue(undefined)
        const helper = create(authorize)
        await expect(helper.uninstall()).rejects.toThrow('Authorization canceled')
        expect(helper.status).toEqual({
            state: 'error',
            error: 'Helper uninstall failed: Authorization canceled'
        })
        expect(JSON.parse(await readFile(join(directory, 'helper-client.json'), 'utf8'))).toEqual({
            token
        })
        await helper.uninstall()
        expect(helper.status.state).toBe('missing')
        expect(authorize).toHaveBeenCalledTimes(2)
        helper.close()
    })

    it('deduplicates uninstall and blocks competing installs and privileged operations', async () => {
        let finish!: () => void
        const authorize = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve
                })
        )
        const helper = create(authorize)
        const first = helper.uninstall()
        expect(helper.uninstall()).toBe(first)
        expect((await helper.refresh()).state).toBe('uninstalling')
        await expect(helper.install()).rejects.toThrow('being uninstalled')
        await expect(helper.repair()).rejects.toThrow('being uninstalled')
        await expect(helper.ensureInstalled()).rejects.toThrow('being uninstalled')
        await expect(helper.installCertificate(Buffer.from('CA'))).rejects.toThrow(
            'being uninstalled'
        )
        await expect(helper.startTun({})).rejects.toThrow('being uninstalled')
        finish()
        await first
        expect(authorize).toHaveBeenCalledOnce()
        helper.close()
    })

    it('waits for in-progress removal when the app closes', async () => {
        let finish!: () => void
        const helper = create(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve
                })
        )
        const removal = helper.uninstall()
        let closed = false
        const closing = helper.close()!.then(() => {
            closed = true
        })
        await Promise.resolve()
        expect(closed).toBe(false)
        finish()
        await Promise.all([removal, closing])
        expect(closed).toBe(true)
    })

    it('does not interrupt a pending certificate operation', async () => {
        const authorize = vi.fn(async () => {})
        const helper = create(authorize)
        let finish!: () => void
        vi.spyOn(helper, 'ensureInstalled').mockImplementation(
            () =>
                new Promise<void>((_resolve, reject) => {
                    finish = () => reject(new Error('Simulated certificate setup failure'))
                })
        )
        const request = helper.installCertificate(Buffer.from('CA'))
        const failure = expect(request).rejects.toThrow('Simulated certificate setup failure')
        await expect(helper.uninstall()).rejects.toThrow('current Helper Tool operation')
        expect(authorize).not.toHaveBeenCalled()
        finish()
        await failure
        await helper.uninstall()
        expect(authorize).toHaveBeenCalledOnce()
    })

    it('uses only fixed Electron service paths and stops the service before removal', async () => {
        const script = uninstallationScript()
        const file = join(directory, 'uninstall-syntax.sh')
        await writeFile(file, script)
        // Parse only. Never execute the privileged uninstall script in tests.
        await promisify(execFile)('/bin/sh', ['-n', file])
        const removals = script.split('\n').filter((line) => line.startsWith('/bin/rm '))
        expect(removals).toEqual([
            `/bin/rm -f '/Library/LaunchDaemons/${helperID}.plist'`,
            `/bin/rm -rf '/Library/PrivilegedHelperTools/${helperID}' '/private/var/run/${helperID}'`,
            `/bin/rm -f '/private/var/run/${helperID}.sock'`
        ])
        expect(script.indexOf('bootout')).toBeLessThan(script.indexOf('/bin/rm '))
        expect(script).toContain('Helper is still stopping; uninstall stopped')
        expect(script).not.toContain('/usr/bin/security')
        expect(script).not.toContain('dev.fengqi.fluxy.helper')
    })
})

// Revocation remains available after upgrading Fluxy, even if new assets are absent.
it('removes a CA through the paired helper without checking the current bundle version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-revoke-old-helper-'))
    const request = vi
        .spyOn(HelperRPC.prototype, 'request')
        .mockResolvedValue({ buildID: 'old', tunRunning: false })
    const helper = new HelperService(directory, '/missing/helper', '/missing/core', () => {})
    try {
        await writeFile(
            join(directory, 'helper-client.json'),
            JSON.stringify({ token: 'a'.repeat(64) })
        )
        const der = Buffer.from('test certificate bytes')
        await helper.removeCertificate(der)
        expect(request).toHaveBeenCalledWith('ca.remove', der.toString('base64'), 90000)
    } finally {
        await helper.close()
        request.mockRestore()
        await rm(directory, { recursive: true, force: true })
    }
})
