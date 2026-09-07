import { app } from 'electron'
import { join } from 'node:path'

export function configureAboutPanel() {
    app.setAboutPanelOptions({
        applicationName: 'Fluxy',
        applicationVersion: app.getVersion(),
        copyright: 'Copyright © 2026 Fluxy contributors',
        authors: ['Fluxy contributors', 'Based on Rockxy by Nguyen Huu Loc and contributors'],
        website: 'https://github.com/fqix/fluxy',
        iconPath: join(app.getAppPath(), 'resources', 'icon.png'),
        credits: [
            'HTTP, HTTPS and TUN network inspector',
            'https://github.com/fqix/fluxy',
            '',
            'Original Fluxy contributions: MIT License.',
            'Built with Electron, React, shadcn/ui and Tailwind CSS.',
            'TUN core: sing-box by nekohasekai (GPL-3.0-or-later).',
            '',
            'Based on Rockxy by Nguyen Huu Loc and contributors.',
            'Retained Rockxy-derived material: AGPL-3.0-or-later.',
            'Third-party components retain their own licenses.',
            'Full notices: github.com/fqix/fluxy/blob/main/THIRD_PARTY_NOTICES.md'
        ].join('\n')
    })
}
