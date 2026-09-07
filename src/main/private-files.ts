import { writeFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Write private exports without following an existing symlink or retaining its mode.
export async function writePrivateFile(path: string, data: string | Buffer) {
    const temporary = join(dirname(path), `.fluxy-${randomUUID()}.tmp`)
    try {
        await writeFile(temporary, data, { mode: 0o600, flag: 'wx' })
        await rename(temporary, path)
    } finally {
        await rm(temporary, { force: true })
    }
}
