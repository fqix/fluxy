import type { Menu, MenuItemConstructorOptions } from 'electron'
import type { MenuCommand, MenuState } from '../../shared/app/menu'

type Item = MenuItemConstructorOptions
// Electron removes redundant separators and may add native role items, so the
// installed menu cannot be addressed using template array positions. Resolve
// IDs within each submenu: the same command may have different state elsewhere.
export function updateMenuItems(menu: Menu, template: Item[]): boolean {
    for (const value of template) {
        const children = Array.isArray(value.submenu) ? value.submenu : undefined
        if (!value.id && !children) continue
        const current = menu.items.find((item) =>
            value.id
                ? item.id === value.id
                : value.role
                  ? item.role === value.role
                  : item.label === value.label
        )
        if (!current || current.type !== (value.type ?? (children ? 'submenu' : 'normal')))
            return false
        if (value.id) {
            current.enabled = value.enabled ?? true
            current.label = value.label ?? current.label
            if (value.type === 'checkbox' || value.type === 'radio')
                current.checked = value.checked ?? false
        }
        if (children && (!current.submenu || !updateMenuItems(current.submenu, children)))
            return false
    }
    return true
}

export function buildMenuTemplate(
    state: MenuState,
    command: (command: MenuCommand) => void,
    platform: NodeJS.Platform,
    packaged: boolean
): Item[] {
    const mac = platform === 'darwin'
    const available = state.ready && !state.busy && !state.modal
    const selected = available && state.selectionCount > 0
    const projectAvailable = available && !state.projectError
    const item = (
        label: string,
        id: MenuCommand,
        accelerator?: string,
        enabled = available
    ): Item => ({ id, label, accelerator, enabled, click: () => command(id) })
    const toggle = (
        label: string,
        id: MenuCommand,
        checked: boolean,
        accelerator?: string,
        enabled = available
    ): Item => ({ ...item(label, id, accelerator, enabled), type: 'checkbox', checked })
    const separator: Item = { type: 'separator' }
    const tool = (label: MenuCommand, accelerator?: string) => item(label, label, accelerator)
    const panels = mac
        ? ['Command+Control+[', 'Command+Control+]', 'Command+Control+\\']
        : ['Ctrl+Alt+[', 'Ctrl+Alt+]', 'Ctrl+Alt+\\']
    const exporting: Item[] = [
        item('Export as HAR…', 'export-selected', undefined, selected),
        item('Export as OpenAPI YAML…', 'openapi-yaml', undefined, selected),
        item('Export as OpenAPI HTML…', 'openapi-html', undefined, selected),
        separator,
        item('Publish Selected to Gist…', 'Publish Selected to Gist', undefined, selected)
    ]
    return [
        ...(mac
            ? [
                  {
                      label: 'Fluxy',
                      submenu: [
                          { role: 'about' },
                          separator,
                          item('Check for Updates…', 'check-updates'),
                          separator,
                          item('Change Logs…', 'changelog'),
                          separator,
                          item('Settings…', 'Settings', 'CmdOrCtrl+,'),
                          separator,
                          { role: 'services' },
                          separator,
                          { role: 'hide' },
                          { role: 'hideOthers' },
                          { role: 'unhide' },
                          separator,
                          { role: 'quit' }
                      ]
                  } as Item
              ]
            : []),
        {
            label: 'File',
            submenu: [
                item('New Tab', 'new-workspace', 'CmdOrCtrl+T', projectAvailable),
                item(
                    'Close Tab',
                    'close-workspace',
                    'CmdOrCtrl+W',
                    projectAvailable && state.canCloseWorkspace
                ),
                item('Rename Tab…', 'rename-workspace', 'CmdOrCtrl+Shift+R', projectAvailable),
                item('New Session', 'new-session'),
                separator,
                item('Open Session…', 'sessions', 'CmdOrCtrl+O'),
                item(
                    'Save Session…',
                    'Save Session',
                    'CmdOrCtrl+Shift+S',
                    available && state.hasTraffic
                ),
                separator,
                item('Import HAR…', 'import', 'CmdOrCtrl+Shift+I'),
                item('Export HAR…', 'export', 'CmdOrCtrl+Shift+E', available && state.hasTraffic),
                item(
                    'Export OpenAPI YAML…',
                    'openapi-yaml',
                    undefined,
                    available && (state.hasTraffic || state.selectionCount > 0)
                ),
                item(
                    'Export OpenAPI HTML…',
                    'openapi-html',
                    undefined,
                    available && (state.hasTraffic || state.selectionCount > 0)
                ),
                separator,
                ...(!mac ? [item('Settings…', 'Settings', 'CmdOrCtrl+,'), separator] : []),
                { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' },
                ...(!mac ? [{ role: 'quit' } as Item] : [])
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                separator,
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'delete' },
                { role: 'selectAll' },
                separator,
                item('Copy URL', 'copy-url', 'CmdOrCtrl+Alt+U', selected),
                item('Copy as cURL', 'copy-curl', 'CmdOrCtrl+Shift+C', selected),
                item('Focus on URL', 'focus-url', 'CmdOrCtrl+L'),
                item('Find in Capture', 'find', 'CmdOrCtrl+F')
            ]
        },
        {
            label: 'Project',
            submenu: [
                item(
                    'New Project…',
                    'new-project',
                    'CmdOrCtrl+Shift+N',
                    projectAvailable && state.projects.length < 100
                ),
                item('Rename Project…', 'rename-project', undefined, projectAvailable),
                tool('Manage Projects'),
                separator,
                item(
                    'Export Project Configuration…',
                    'export-project',
                    undefined,
                    projectAvailable
                ),
                item(
                    'Import Project Configuration…',
                    'import-project',
                    undefined,
                    projectAvailable && state.projects.length < 100
                ),
                separator,
                ...state.projects.map((p) => ({
                    ...item(p.name, `project:${p.id}`, undefined, projectAvailable),
                    type: 'radio' as const,
                    checked: p.id === state.activeProjectID
                })),
                ...(state.projectError
                    ? [separator, item('Repair Projects…', 'repair-project')]
                    : [])
            ]
        },
        {
            label: 'View',
            submenu: [
                toggle('Filter Domain or App', 'advanced', state.advanced, 'CmdOrCtrl+Shift+F'),
                separator,
                toggle('Follow Live Traffic', 'auto-select', state.autoSelect, 'CmdOrCtrl+Shift+L'),
                separator,
                toggle('Toggle Source List Panel', 'sidebar', state.sidebar, panels[0]),
                separator,
                item(
                    state.inspector ? 'Hide Bottom Inspector' : 'Show Bottom Inspector',
                    'inspector',
                    panels[1],
                    selected
                ),
                item(state.dock ? 'Hide Context Dock' : 'Show Context Dock', 'dock', panels[2]),
                separator,
                item(
                    'Select Next Tab',
                    'next-workspace',
                    'CmdOrCtrl+Shift+]',
                    available && state.projects.length > 0
                ),
                item(
                    'Select Previous Tab',
                    'previous-workspace',
                    'CmdOrCtrl+Shift+[',
                    available && state.projects.length > 0
                ),
                separator,
                item(
                    'Jump to First Request',
                    'first-request',
                    undefined,
                    available && state.hasVisible
                ),
                item(
                    'Jump to Last Request',
                    'last-request',
                    undefined,
                    available && state.hasVisible
                ),
                separator,
                {
                    label: 'Appearance',
                    submenu: (['system', 'light', 'dark'] as const).map((theme) => ({
                        ...item(
                            theme === 'system'
                                ? 'Follow System'
                                : theme === 'light'
                                  ? 'Light'
                                  : 'Dark',
                            `theme-${theme}`
                        ),
                        type: 'radio',
                        checked: state.theme === theme
                    }))
                },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { role: 'togglefullscreen' },
                ...(!packaged ? [separator, { role: 'toggleDevTools' } as Item] : [])
            ]
        },
        {
            label: 'Flow',
            submenu: [
                item('Compose…', 'Compose', 'CmdOrCtrl+Alt+N'),
                separator,
                item('Repeat', 'repeat', 'CmdOrCtrl+R', selected && state.canReplay),
                item('Edit and Repeat…', 'edit-resend', 'CmdOrCtrl+E', selected && state.canReplay),
                separator,
                { label: 'Export', submenu: exporting },
                separator,
                item('Add Note…', 'note', undefined, selected),
                {
                    label: 'Highlight',
                    submenu: [
                        ...(['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const).map(
                            (color) =>
                                item(
                                    color[0].toUpperCase() + color.slice(1),
                                    `highlight:${color}`,
                                    undefined,
                                    selected
                                )
                        ),
                        separator,
                        item('Remove Highlight', 'highlight:none', undefined, selected)
                    ]
                },
                separator,
                item('Clear Session', 'clear', 'CmdOrCtrl+K', available && state.hasTraffic),
                item('Clear Session and Filters', 'clear-filters', 'CmdOrCtrl+Shift+K'),
                separator,
                item('Delete', 'delete-selected', 'CmdOrCtrl+Backspace', selected),
                separator,
                toggle('Pin Request', 'pin', state.pinned, undefined, selected),
                toggle('Save Request', 'save-request', state.saved, undefined, selected)
            ]
        },
        {
            label: 'Tools',
            submenu: [
                item(
                    'Start Proxy',
                    'start-proxy',
                    undefined,
                    available && !state.running && !state.transportBusy
                ),
                item(
                    'Stop Proxy',
                    'stop-proxy',
                    'CmdOrCtrl+.',
                    available && state.running && !state.transportBusy
                ),
                item(
                    state.recording ? 'Pause Recording' : 'Resume Recording',
                    'record',
                    'CmdOrCtrl+Alt+R',
                    available && state.running
                ),
                toggle(
                    'Toggle System Proxy',
                    'system-proxy',
                    state.systemProxy,
                    'CmdOrCtrl+Alt+O',
                    available &&
                        ['darwin', 'win32', 'linux'].includes(platform) &&
                        !state.transportBusy &&
                        (state.systemProxy || state.captureMode === 'proxy')
                ),
                separator,
                item('Debug My App…', 'Developer Setup'),
                separator,
                toggle('No Caching', 'no-cache', state.noCache),
                separator,
                item('HTTPS Decryption…', 'SSL Proxying', 'CmdOrCtrl+Alt+P'),
                item('Full Proxy Bypass…', 'Full Proxy Bypass', 'CmdOrCtrl+Alt+B'),
                {
                    label: 'Proxy Settings',
                    submenu: [
                        toggle(
                            'Use External Proxy',
                            'external-proxy',
                            state.upstream,
                            'CmdOrCtrl+Alt+E',
                            available && !state.running && !state.transportBusy
                        ),
                        item('External Proxy Settings…', 'Upstream Proxy')
                    ]
                },
                separator,
                item('Breakpoint Rules…', 'Breakpoint', 'CmdOrCtrl+Shift+B'),
                item('Add Breakpoint Rule', 'add-breakpoint', 'CmdOrCtrl+B', selected),
                item('Breakpoint Queue…', 'Breakpoint Queue'),
                item('Breakpoint Templates…', 'Breakpoint Templates'),
                separator,
                item('Map Local…', 'Map Local', 'CmdOrCtrl+Alt+L'),
                item('Map Remote…', 'Map Remote'),
                separator,
                item('Block List…', 'Block List', 'CmdOrCtrl+Alt+['),
                item('Allow List…', 'Allow List', 'CmdOrCtrl+Alt+A'),
                item('Modify Headers…', 'Modify Headers'),
                separator,
                item('Protobuf…', 'Protobuf'),
                item('Network Conditions…', 'Network Conditions'),
                item('Inspector Preview Tabs…', 'Inspector Preview Tabs'),
                item('Custom Header Columns…', 'Custom Header Columns'),
                separator,
                {
                    label: 'Fluxy',
                    submenu: [
                        tool('Welcome to Fluxy'),
                        tool('TUN Mode'),
                        tool('Helper Tool'),
                        tool('MCP Server'),
                        tool('Logs'),
                        item(
                            state.running ? 'Stop Capture' : 'Start Capture',
                            'toggle-proxy',
                            'CmdOrCtrl+Shift+P',
                            available && !state.transportBusy
                        )
                    ]
                }
            ]
        },
        {
            label: 'Diff',
            submenu: [
                item('Open Diff View…', 'Diff', 'CmdOrCtrl+Alt+Y'),
                separator,
                item(
                    'Compare Selected',
                    'compare',
                    'CmdOrCtrl+Alt+D',
                    available && state.selectionCount === 2
                )
            ]
        },
        { label: 'Scripting', submenu: [item('Script List…', 'Scripting', 'CmdOrCtrl+Alt+I')] },
        {
            label: 'Certificate',
            submenu: [
                item('Install Certificate on This Mac…', 'Certificates'),
                item(
                    'Uninstall Certificate…',
                    'uninstall-certificate',
                    undefined,
                    available && mac && !state.transportBusy
                ),
                separator,
                item('Add Custom Certificates…', 'Custom Certificates'),
                separator,
                {
                    label: 'Export',
                    submenu: [
                        item('Private Key…', 'certificate-key'),
                        item('Root Certificate as P12…', 'certificate-p12'),
                        item('Root Certificate as PEM…', 'certificate-pem'),
                        item('Root Certificate as DER…', 'certificate-der')
                    ]
                },
                separator,
                item(
                    'Reset all Fluxy Certificates',
                    'reset-certificates',
                    undefined,
                    available && !state.running && !state.transportBusy
                )
            ]
        },
        {
            label: 'Setup',
            submenu: [
                item('Automatic Setup...', 'automatic-setup'),
                separator,
                item('Manual Setup...', 'manual-setup')
            ]
        },
        { role: 'windowMenu' },
        {
            role: 'help',
            submenu: [
                item('Getting Started…', 'Welcome to Fluxy'),
                item('Keyboard Shortcuts', 'Keyboard Shortcuts', 'CmdOrCtrl+Shift+/'),
                item('Debug My App…', 'Developer Setup'),
                separator,
                item('Force Reset Fluxy Helper…', 'reset-helper', undefined, available && mac),
                item('Uninstall Fluxy Helper…', 'uninstall-helper', undefined, available && mac),
                separator,
                item('Homepage…', 'homepage'),
                item('Github…', 'repository'),
                item('Technical Documents…', 'docs'),
                separator,
                item('Report Bug…', 'issues'),
                item('Copy Debug Info…', 'debug-info'),
                separator,
                item('Fluxy Help', 'Help'),
                ...(!mac ? [item('Check for Updates…', 'check-updates')] : []),
                ...(!mac ? [{ role: 'about' } as Item] : [])
            ]
        }
    ]
}
