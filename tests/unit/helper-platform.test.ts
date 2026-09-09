import { describe, expect, it, vi, afterEach } from 'vitest'
import {
    helperEndpoint,
    executableName,
    portableInstallationScript,
    portableUninstallationScript,
    windowsInstallationRequest,
    supportedHelperPlatform
} from '../../src/main/system/helper-platform'
import { tunInterfaceName } from '../../src/main/tun/tun-platform'
import { tunSettingsSchema } from '../../src/shared/contracts/model'
const hash = 'a'.repeat(64)
const hashes = { helperSHA256: hash, coreSHA256: hash }
describe('cross-platform helper integration', () => {
    it('uses local platform endpoints and binaries', () => {
        expect(helperEndpoint('win32')).toBe('\\\\.\\pipe\\dev.fengqi.fluxy.electron.helper')
        expect(helperEndpoint('linux')).toBe('/run/dev.fengqi.fluxy.electron.helper/helper.sock')
        expect(executableName('fluxy-core', 'win32')).toBe('fluxy-core.exe')
        expect(executableName('fluxy-core', 'linux')).toBe('fluxy-core')
        expect(supportedHelperPlatform('freebsd')).toBe(false)
        expect(tunInterfaceName(2345, 'darwin')).toBe('utun2345')
        expect(tunInterfaceName(2345, 'linux')).toBe('fluxy2345')
        expect(tunInterfaceName(2345, 'win32')).toBe('fluxy2345')
    })
    it('accepts Windows interface aliases and rejects control characters', () => {
        expect(tunSettingsSchema.parse({ interface: '以太网 2' }).interface).toBe('以太网 2')
        expect(tunSettingsSchema.safeParse({ interface: 'eth0\ncommand' }).success).toBe(false)
    })
    it('pins staged files before activating Linux service and quotes paths', () => {
        const script = portableInstallationScript(
            "/tmp/a'b $(touch sentinel)",
            hashes,
            hash,
            'linux'
        )
        expect(script).toContain("'\"'\"'")
        expect(script.indexOf('sha256sum')).toBeLessThan(script.indexOf('systemctl stop'))
        expect(script).toContain('KillMode=mixed')
        expect(script).toContain('systemctl enable --now')
        expect(portableUninstallationScript('linux')).toContain('systemctl stop')
    })
    it('passes Windows setup as structured data and rejects script setup', () => {
        const stage = "C:\\User's Data\\stage & literal"
        expect(JSON.parse(windowsInstallationRequest(stage, hashes, hash))).toEqual({
            action: 'install',
            stage,
            ...hashes,
            pairingSHA256: hash
        })
        expect(() => portableInstallationScript(stage, hashes, hash, 'win32')).toThrow(
            'only supported on Linux'
        )
        expect(() => portableUninstallationScript('win32')).toThrow('only supported on Linux')
        expect(() =>
            windowsInstallationRequest(stage, { ...hashes, helperSHA256: 'bad' }, hash)
        ).toThrow('checksum')
    })
    it('rejects injectable manifest values', () => {
        expect(() =>
            portableInstallationScript(
                '/tmp/stage',
                { ...hashes, coreSHA256: "';evil" },
                hash,
                'linux'
            )
        ).toThrow('checksum')
    })
})
