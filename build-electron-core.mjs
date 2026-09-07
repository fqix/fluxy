import { execFileSync } from 'node:child_process'
const platform = process.env.FLUXY_BUILD_PLATFORM || process.platform
const arch = process.env.FLUXY_BUILD_ARCH || process.arch
if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch))
    throw new Error('Unsupported core target')
execFileSync(
    process.env.FLUXY_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    [
        'tools/sing-box/build.py',
        '--platform',
        platform === 'win32' ? 'windows' : platform,
        '--arch',
        arch === 'x64' ? 'x86_64' : 'arm64',
        '--output',
        'build/electron-core/fluxy-core' + (platform === 'win32' ? '.exe' : '')
    ],
    { stdio: 'inherit' }
)
