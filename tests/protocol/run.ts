import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Run both suites even when the local regression gate detects a known defect.
let failed = false
for (const script of ['verify.ts', 'public.ts']) {
    const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', fileURLToPath(new URL(script, import.meta.url))],
        {
            stdio: 'inherit'
        }
    )
    if (result.error) console.error(result.error)
    failed ||= result.status !== 0
}
process.exitCode = failed ? 1 : 0
