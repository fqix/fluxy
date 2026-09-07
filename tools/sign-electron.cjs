const { sign: signBundle } = require('@electron/osx-sign')
const { execFileSync } = require('node:child_process')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
function refreshManifests(resources) {
    const core = join(resources, 'core', 'fluxy-core')
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
async function sign(options) {
    if (!options.identity) throw new Error('A Developer ID signing identity is required')
    await signBundle(options)
    // Nested Mach-O signatures change bytes. Refresh integrity metadata before sealing
    // the outer bundle a second time; electron-builder notarizes only after this returns.
    refreshManifests(join(options.app, 'Contents', 'Resources'))
    const args = [
        '--force',
        '--sign',
        options.identity,
        '--options',
        'runtime',
        '--preserve-metadata=entitlements,requirements,flags'
    ]
    if (options.identity !== '-') args.push('--timestamp')
    if (options.keychain) args.push('--keychain', options.keychain)
    execFileSync('/usr/bin/codesign', [...args, options.app], { stdio: 'inherit' })
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', options.app], {
        stdio: 'inherit'
    })
}
module.exports = sign
module.exports.refreshManifests = refreshManifests
