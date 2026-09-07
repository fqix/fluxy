import { z } from 'zod'

export const toolCommands = [
    'Settings',
    'Welcome to Fluxy',
    'TUN Mode',
    'Helper Tool',
    'Compose',
    'Block List',
    'Allow List',
    'Map Local',
    'Map Remote',
    'Modify Headers',
    'Breakpoint',
    'Throttle',
    'Network Conditions',
    'Updates',
    'SSL Proxying',
    'Certificates',
    'Developer Setup',
    'Upstream Proxy',
    'Scripting',
    'MCP Server',
    'Logs',
    'Help',
    'Custom Certificates',
    'Protobuf',
    'Publish Selected to Gist',
    'Full Proxy Bypass',
    'Inspector Preview Tabs',
    'Custom Header Columns',
    'Manage Projects',
    'Keyboard Shortcuts',
    'Diff',
    'Breakpoint Queue',
    'Breakpoint Templates'
] as const
export type MenuCommand =
    | (typeof toolCommands)[number]
    | 'check-updates'
    | 'new-project'
    | 'rename-project'
    | 'export-project'
    | 'import-project'
    | 'repair-project'
    | `project:${string}`
    | `highlight:${'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'none'}`
    | 'new-session'
    | 'focus-url'
    | 'note'
    | 'delete-selected'
    | 'openapi-yaml'
    | 'openapi-html'
    | 'start-proxy'
    | 'stop-proxy'
    | 'external-proxy'
    | 'add-breakpoint'
    | 'certificate-key'
    | 'certificate-p12'
    | 'reset-certificates'
    | 'reset-helper'
    | 'uninstall-helper'
    | `setup:${string}`
    | 'certificate-pem'
    | 'certificate-der'
    | 'automatic-setup'
    | 'manual-setup'
    | 'homepage'
    | 'repository'
    | 'docs'
    | 'issues'
    | 'changelog'
    | 'debug-info'
    | 'new-workspace'
    | 'close-workspace'
    | 'rename-workspace'
    | 'next-workspace'
    | 'previous-workspace'
    | 'sessions'
    | 'Save Session'
    | 'import'
    | 'export'
    | 'export-selected'
    | 'copy-url'
    | 'copy-curl'
    | 'find'
    | 'sidebar'
    | 'inspector'
    | 'dock'
    | 'advanced'
    | 'auto-select'
    | 'first-request'
    | 'last-request'
    | 'toggle-proxy'
    | 'record'
    | 'clear'
    | 'clear-filters'
    | 'system-proxy'
    | 'no-cache'
    | 'edit-resend'
    | 'repeat'
    | 'pin'
    | 'save-request'
    | 'compare'
    | 'theme-system'
    | 'theme-light'
    | 'theme-dark'

// Only bounded UI state crosses this channel; it cannot execute a menu command.
export const menuStateSchema = z
    .object({
        projects: z
            .array(z.object({ id: z.string().uuid(), name: z.string().min(1).max(100) }))
            .max(100),
        activeProjectID: z.string().uuid().optional(),
        projectError: z.boolean(),
        upstream: z.boolean(),
        ready: z.boolean(),
        busy: z.boolean(),
        modal: z.boolean(),
        canCloseWorkspace: z.boolean(),
        canReplay: z.boolean(),
        selectionCount: z.number().int().min(0).max(1000000),
        hasTraffic: z.boolean(),
        hasVisible: z.boolean(),
        pinned: z.boolean(),
        saved: z.boolean(),
        sidebar: z.boolean(),
        inspector: z.boolean(),
        dock: z.boolean(),
        advanced: z.boolean(),
        autoSelect: z.boolean(),
        running: z.boolean(),
        recording: z.boolean(),
        systemProxy: z.boolean(),
        captureMode: z.enum(['proxy', 'tun']),
        transportBusy: z.boolean(),
        noCache: z.boolean(),
        theme: z.enum(['system', 'light', 'dark'])
    })
    .strict()
export type MenuState = z.infer<typeof menuStateSchema>
export const initialMenuState: MenuState = {
    projects: [],
    projectError: false,
    upstream: false,
    ready: false,
    busy: false,
    modal: false,
    canCloseWorkspace: false,
    canReplay: false,
    selectionCount: 0,
    hasTraffic: false,
    hasVisible: false,
    pinned: false,
    saved: false,
    sidebar: true,
    inspector: true,
    dock: false,
    advanced: false,
    autoSelect: false,
    running: false,
    recording: true,
    systemProxy: false,
    captureMode: 'proxy',
    transportBusy: false,
    noCache: false,
    theme: 'system'
}
