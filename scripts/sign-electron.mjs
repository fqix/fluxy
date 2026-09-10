import { sign as signBundle } from '@electron/osx-sign'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
export function refreshManifests(resources) {
    const core = join(resources, 'core', 'sing-box')
    const helper = join(resources, 'helper', 'fluxy-helper')
    const coreSHA256 = hash(core),
        helperSHA256 = hash(helper)
    const coreManifest = JSON.parse(readFileSync(core + '.build.json', 'utf8'))
    coreManifest.signedSHA256 = coreSHA256
    writeFileSync(core + '.build.json', JSON.stringify(coreManifest, null, 2) + '\n')
    const helperManifest = JSON.parse(readFileSync(helper + '.json', 'utf8'))
    Object.assign(helperManifest, {
        coreSHA256,
        helperSHA256,
        buildID: createHash('sha256')
            .update(helperSHA256 + coreSHA256)
            .digest('hex')
    })
    writeFileSync(helper + '.json', JSON.stringify(helperManifest, null, 2) + '\n')
}
export default async function sign(options) {
    if (!options.identity)
        throw new Error("A signing identity is required (use '-' for ad-hoc signing)")
    await signBundle(options)
    // Nested Mach-O signatures change bytes. Refresh integrity metadata before sealing
    // the outer bundle a second time; electron-builder notarizes only after this returns.
    refreshManifests(join(options.app, 'Contents', 'Resources'))
    const args = [
        '--force',
        '--sign',
        options.identity,
        '--preserve-metadata=entitlements,requirements,flags'
    ]
    if (options.identity !== '-') args.push('--options', 'runtime', '--timestamp')
    if (options.keychain) args.push('--keychain', options.keychain)
    execFileSync('/usr/bin/codesign', [...args, options.app], { stdio: 'inherit' })
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', options.app], {
        stdio: 'inherit'
    })
}
