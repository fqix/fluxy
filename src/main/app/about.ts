import { app } from 'electron'
import { join } from 'node:path'

export function configureAboutPanel() {
    app.setAboutPanelOptions({
        applicationName: 'Fluxy',
        applicationVersion: app.getVersion(),
        version: '',
        copyright: '',
        credits: '',
        iconPath: join(app.getAppPath(), 'resources', 'icon.png')
    })
}
