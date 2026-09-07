import { describe, expect, it, vi, afterEach } from 'vitest'
import {
    helperEndpoint,
    executableName,
    portableInstallationScript,
    portableUninstallationScript,
    encodedPowerShell,
    supportedHelperPlatform
} from '../../src/main/helper-platform'
import { tunInterfaceName } from '../../src/main/tun-platform'
import { tunSettingsSchema } from '../../src/shared/model'
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
    it('restricts Windows ACLs, pins files, and uses SCM lifecycle', () => {
        const script = portableInstallationScript("C:\\User's Data\\stage", hashes, hash, 'win32')
        expect(script).toContain("User''s Data")
        expect(script).toContain('$acl.SetAccessRuleProtection($true,$false)')
        expect(script.indexOf('Get-FileHash')).toBeLessThan(script.indexOf('Stop-Service'))
        expect(script).toContain('New-Service')
        expect(script).toContain('fluxy-helper.exe')
        expect(portableUninstallationScript('win32')).toContain("WaitForStatus('Stopped'")
        expect(Buffer.from(encodedPowerShell(script), 'base64').toString('utf16le')).toBe(script)
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
