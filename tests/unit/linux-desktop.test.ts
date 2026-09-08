import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LinuxTargetHelper } from 'app-builder-lib/out/targets/LinuxTargetHelper'
import { convertIcon } from 'app-builder-lib/out/util/iconConverter'

const temporary: string[] = []
afterEach(async () => {
    await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it('packages icons at hicolor sizes and associates running windows with the desktop entry', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'))
    const outDir = await mkdtemp(join(tmpdir(), 'fluxy-linux-icons-'))
    temporary.push(outDir)
    const packager = {
        config: pkg.build,
        info: { metadata: pkg },
        platformSpecificBuildOptions: pkg.build.linux,
        executableName: pkg.name,
        appInfo: {
            productName: 'Fluxy',
            sanitizedProductName: 'Fluxy',
            description: pkg.description
        },
        fileAssociations: [],
        getDefaultFrameworkIcon: () => [],
        resolveIcon: async (sources: string[], fallbackSources: string[]) => {
            const result = await convertIcon({
                sources,
                fallbackSources,
                roots: [resolve('.')],
                format: 'set',
                outDir
            })
            expect(result.error).toBeUndefined()
            expect(result.isFallback).toBe(false)
            return result.icons
        }
    }
    const helper = new LinuxTargetHelper(packager as never)
    const icons = await helper.icons
    expect(icons.map((icon) => icon.size)).toEqual(
        expect.arrayContaining([16, 24, 32, 48, 64, 128, 256, 512])
    )
    const desktopName = helper.getDesktopFileName()
    expect(`${desktopName}.desktop`).toBe(pkg.desktopName)
    const entry = await helper.computeDesktopEntry(pkg.build.linux)
    expect(entry).toContain(`\nStartupWMClass=${desktopName}\n`)
    expect(entry).toContain('\nIcon=fluxy\n')
})
