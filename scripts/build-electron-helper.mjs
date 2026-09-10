import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const platform = process.env.FLUXY_BUILD_PLATFORM || process.platform
const arch = process.env.FLUXY_BUILD_ARCH || process.arch
if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch))
    throw new Error('Unsupported helper target')

mkdirSync('build/electron-helper', { recursive: true })
const suffix = platform === 'win32' ? '.exe' : ''
const output = 'build/electron-helper/fluxy-helper' + suffix
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const go = process.env.FLUXY_GO || 'go'
execFileSync(
    go,
    [
        'build',
        '-mod=readonly',
        '-trimpath',
        '-buildvcs=false',
        '-ldflags=-s -w',
        '-o',
        '../../' + output,
        '.'
    ],
    {
        cwd: 'tools/helper',
        stdio: 'inherit',
        env: {
            ...process.env,
            GOOS: platform === 'win32' ? 'windows' : platform,
            GOARCH: arch === 'x64' ? 'amd64' : 'arm64',
            CGO_ENABLED: platform === 'darwin' ? '1' : '0',
            MACOSX_DEPLOYMENT_TARGET: '13.0',
            ...(platform === 'darwin'
                ? {
                      CGO_CFLAGS: '-O2 -g -mmacosx-version-min=13.0',
                      CGO_LDFLAGS: '-mmacosx-version-min=13.0'
                  }
                : {}),
            GOWORK: 'off',
            GOFLAGS: ''
        }
    }
)
const helperSHA256 = hash(output)
const coreSHA256 = hash('build/electron-core/sing-box' + suffix)
const buildID = createHash('sha256')
    .update(helperSHA256 + coreSHA256)
    .digest('hex')
writeFileSync(
    output + '.json',
    JSON.stringify({ version: 1, platform, arch, buildID, helperSHA256, coreSHA256 }, null, 2) +
        '\n'
)
const moduleCache = execFileSync(go, ['env', 'GOMODCACHE'], { encoding: 'utf8' }).trim()
const notices = [
    ...(platform === 'win32'
        ? [['Microsoft/go-winio', moduleCache + '/github.com/!microsoft/go-winio@v0.6.2/LICENSE']]
        : []),
    ['golang.org/x/sys', moduleCache + '/golang.org/x/sys@v0.47.0/LICENSE'],
    ['Go', execFileSync(go, ['env', 'GOROOT'], { encoding: 'utf8' }).trim() + '/LICENSE']
]
writeFileSync(
    'build/electron-helper/fluxy-helper.licenses.txt',
    notices
        .map(
            ([name, path]) =>
                name +
                '\n' +
                readFileSync(
                    existsSync(path) ? path : join(dirname(dirname(path)), 'LICENSE'),
                    'utf8'
                )
        )
        .join('\n\n')
)
