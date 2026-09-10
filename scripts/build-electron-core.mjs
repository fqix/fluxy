import { execFileSync } from 'node:child_process'
const platform = process.env.FLUXY_BUILD_PLATFORM || process.platform
const arch = process.env.FLUXY_BUILD_ARCH || process.arch
if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch))
    throw new Error('Unsupported core target')
execFileSync(
    process.execPath,
    [
        'scripts/build-sing-box.mjs',
        ...(process.env.FLUXY_CORE_RACE === '1' ? ['--race'] : []),
        '--platform',
        platform === 'win32' ? 'windows' : platform,
        '--arch',
        arch === 'x64' ? 'x86_64' : 'arm64',
        '--output',
        'build/electron-core/sing-box' + (platform === 'win32' ? '.exe' : '')
    ],
    { stdio: 'inherit' }
)
