import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function prepareRelease(directory, version, platform, arch) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable release version')
    const os = { darwin: 'mac', linux: 'linux', win32: 'win' }[platform]
    if (!os || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported release target')
    const required = { darwin: ['dmg', 'zip'], linux: ['deb', 'rpm'], win32: ['exe'] }[platform]
    const prefix = `Fluxy-${version}-${os}-`
    const names = readdirSync(directory).filter((name) => name.startsWith(prefix))
    const versioned = []
    const stable = []
    for (const extension of required) {
        const packageArch =
            extension === 'deb' && arch === 'x64'
                ? 'amd64'
                : extension === 'rpm'
                  ? arch === 'x64'
                      ? 'x86_64'
                      : 'aarch64'
                  : arch
        const name = `${prefix}${packageArch}.${extension}`
        if (!names.includes(name)) throw new Error(`Missing release artifact: ${name}`)
        const digest = createHash('sha256')
            .update(readFileSync(join(directory, name)))
            .digest('hex')
        writeFileSync(join(directory, name + '.sha256'), `${digest}  ${name}\n`)
        versioned.push(name, name + '.sha256')
        stable.push(name, name + '.sha256')
        // Stable aliases let the installer work without Node, Python or a JSON parser.
        const alias = `Fluxy-${os}-${arch}.${extension}`
        copyFileSync(join(directory, name), join(directory, alias))
        writeFileSync(join(directory, alias + '.sha256'), `${digest}  ${alias}\n`)
        stable.push(alias, alias + '.sha256')
    }
    for (const name of names.filter(
        (name) => name.startsWith(`${prefix}${arch}.`) && name.endsWith('.blockmap')
    )) {
        versioned.push(name)
        stable.push(name)
    }
    const manifest = {
        darwin: 'latest-mac.yml',
        linux: arch === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml',
        win32: 'latest.yml'
    }[platform]
    const text = readFileSync(join(directory, manifest), 'utf8')
    if (!text.split(/\r?\n/).some((line) => line.trim() === `version: ${version}`))
        throw new Error('Update manifest version differs')
    // Versioned releases share one asset namespace across all architectures.
    // Stable feeds retain the filenames expected by electron-updater.
    const versionedManifest = `latest-${os}-${arch}.yml`
    if (versionedManifest !== manifest)
        copyFileSync(join(directory, manifest), join(directory, versionedManifest))
    versioned.push(versionedManifest)
    const plan = { version, platform, arch, versioned, stable, manifest }
    writeFileSync(join(directory, 'release-plan.json'), JSON.stringify(plan, null, 2) + '\n')
    return plan
}

// Only the final release job publishes, avoiding concurrent creation of shared feeds.
export function publishRelease(directories, tag) {
    if (!/^electron-v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Invalid release tag')
    const entries = directories.map((directory) => ({
        directory,
        plan: JSON.parse(readFileSync(join(directory, 'release-plan.json'), 'utf8'))
    }))
    for (const { directory, plan } of entries) {
        if (`electron-v${plan.version}` !== tag) throw new Error('Release plan version differs')
        for (const name of [...plan.versioned, ...plan.stable, plan.manifest]) {
            if (basename(name) !== name) throw new Error('Invalid release asset path')
            readFileSync(join(directory, name))
        }
    }
    const gh = (args) => execFileSync('gh', args, { stdio: 'inherit' })
    const exists = (name) => {
        try {
            execFileSync('gh', ['release', 'view', name], { stdio: 'ignore' })
            return true
        } catch {
            return false
        }
    }
    const files = entries.flatMap(({ directory, plan }) =>
        plan.versioned.map((name) => join(directory, name))
    )
    files.push('install.sh', 'install.ps1')
    if (!exists(tag))
        gh([
            'release',
            'create',
            tag,
            '--verify-tag',
            '--title',
            `Fluxy ${tag.slice(10)}`,
            '--generate-notes',
            ...files
        ])
    else gh(['release', 'upload', tag, ...files, '--clobber'])
    for (const { directory, plan } of entries) {
        const feed = `electron-stable-${plan.arch}`
        if (!exists(feed))
            gh([
                'release',
                'create',
                feed,
                '--target',
                tag,
                '--title',
                `Fluxy updates (${plan.arch})`,
                '--notes',
                'Stable Fluxy installers and update metadata.',
                '--latest=false'
            ])
        gh([
            'release',
            'upload',
            feed,
            ...plan.stable.map((name) => join(directory, name)),
            '--clobber'
        ])
        // Update clients see metadata only after its versioned installers have been uploaded.
        gh(['release', 'upload', feed, join(directory, plan.manifest), '--clobber'])
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
    const tag = process.env.RELEASE_TAG
    if (tag !== `electron-v${version}`) throw new Error('Release tag and package version differ')
    if (process.argv[2] === '--prepare')
        prepareRelease('dist', version, process.platform, process.arch)
    else if (process.argv[2] === '--publish') {
        const root = process.argv[3] || 'release-artifacts'
        publishRelease(
            readdirSync(root).map((name) => join(root, name)),
            tag
        )
    } else
        throw new Error(
            'Use --prepare on a build runner or --publish ARTIFACTS on the release runner'
        )
}
