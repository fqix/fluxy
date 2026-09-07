import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function configureAboutPanel(corePath: string) {
    let coreVersion = 'Unavailable'
    try {
        const manifest = JSON.parse(await readFile(`${corePath}.build.json`, 'utf8'))
        if (
            typeof manifest.version === 'string' &&
            /^\d+\.\d+\.\d+[\w.+-]*$/.test(manifest.version)
        )
            coreVersion = manifest.version
    } catch {
        // About remains available if the bundled core is missing or damaged.
    }
    const versions = `Electron ${process.versions.electron}\nsing-box ${coreVersion}`
    app.setAboutPanelOptions({
        applicationName: 'Fluxy',
        applicationVersion: app.getVersion(),
        version: '',
        copyright: process.platform === 'linux' ? versions : '',
        credits: process.platform === 'linux' ? '' : versions,
        iconPath: join(app.getAppPath(), 'resources', 'icon.png')
    })
}
