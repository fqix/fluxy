import { execFileSync, spawnSync } from 'node:child_process'
const platform = process.env.FLUXY_BUILD_PLATFORM || process.platform
const arch = process.env.FLUXY_BUILD_ARCH || process.arch
if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch))
    throw new Error('Unsupported core target')
const pythonCandidates = process.env.FLUXY_PYTHON
    ? [[process.env.FLUXY_PYTHON]]
    : process.platform === 'win32'
      ? [['python'], ['py', '-3']]
      : [['python3']]
const python = pythonCandidates.find(
    ([command, ...args]) =>
        spawnSync(command, [...args, '-c', 'import sys; sys.exit(sys.version_info < (3, 10))'], {
            stdio: 'ignore'
        }).status === 0
)
if (!python)
    throw new Error(
        'Python 3.10+ is required. Install Python, or set FLUXY_PYTHON to its executable path.'
    )
execFileSync(
    python[0],
    [
        ...python.slice(1),
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
