import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { buildMenuTemplate } from '../../src/main/menu'
import { initialMenuState, menuStateSchema, type MenuState } from '../../src/shared/menu'

function menu(
    overrides: Partial<MenuState> = {},
    platform: NodeJS.Platform = 'darwin',
    packaged = false
) {
    return buildMenuTemplate(
        { ...initialMenuState, ready: true, ...overrides },
        () => {},
        platform,
        packaged
    )
}
function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
    return items.flatMap((item) => [
        item,
        ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])
    ])
}
function find(items: MenuItemConstructorOptions[], id: string) {
    return flatten(items).find((item) => item.id === id)!
}
describe('application menu', () => {
    it('gates traffic, selection, comparison and workspace actions', () => {
        const empty = menu()
        for (const id of [
            'copy-url',
            'repeat',
            'compare',
            'export-selected',
            'export',
            'Save Session',
            'first-request',
            'close-workspace',
            'record'
        ]) {
            expect(find(empty, id).enabled, id).toBe(false)
        }
        const capture = menu({
            selectionCount: 2,
            canReplay: true,
            hasTraffic: true,
            hasVisible: true,
            canCloseWorkspace: true,
            running: true
        })
        for (const id of [
            'copy-url',
            'repeat',
            'compare',
            'export-selected',
            'export',
            'Save Session',
            'first-request',
            'close-workspace',
            'record'
        ]) {
            expect(find(capture, id).enabled, id).toBe(true)
        }
        expect(find(menu({ selectionCount: 3 }), 'compare').enabled).toBe(false)
        expect(find(menu({ selectionCount: 1, canReplay: false }), 'repeat').enabled).toBe(false)
    })
    it('disables renderer commands while loading, busy or displaying a dialog', () => {
        for (const state of [{ ready: false }, { busy: true }, { modal: true }]) {
            const commands = flatten(
                menu({ selectionCount: 2, hasTraffic: true, running: true, ...state })
            ).filter((item) => item.id)
            expect(commands.every((item) => item.enabled === false)).toBe(true)
        }
    })
    it('reflects proxy, recording, appearance and view state', () => {
        const items = menu({
            running: true,
            recording: false,
            sidebar: false,
            dock: true,
            pinned: true,
            noCache: true,
            theme: 'dark'
        })
        expect(find(items, 'toggle-proxy').label).toBe('Stop Capture')
        expect(find(items, 'record').label).toBe('Resume Recording')
        expect(find(items, 'sidebar').checked).toBe(false)
        expect(find(items, 'dock').label).toBe('Hide Context Dock')
        for (const id of ['pin', 'no-cache', 'theme-dark'])
            expect(find(items, id).checked).toBe(true)
        expect(find(items, 'theme-light').checked).toBe(false)
    })
    it('keeps system proxy platform and transport restrictions', () => {
        expect(find(menu({ running: true }), 'system-proxy').enabled).toBe(true)
        expect(find(menu({ running: true, captureMode: 'tun' }), 'system-proxy').enabled).toBe(
            false
        )
        expect(find(menu({ running: true, transportBusy: true }), 'toggle-proxy').enabled).toBe(
            false
        )
        expect(find(menu({ systemProxy: true }), 'system-proxy').enabled).toBe(true)
        expect(find(menu({ running: true }, 'win32'), 'system-proxy').enabled).toBe(true)
        expect(find(menu({ running: true }, 'linux'), 'system-proxy').enabled).toBe(true)
        expect(find(menu({}), 'uninstall-helper').enabled).toBe(true)
        expect(find(menu({}, 'win32'), 'uninstall-helper').enabled).toBe(false)
        expect(find(menu({}, 'linux'), 'uninstall-helper').enabled).toBe(false)
    })
    it('provides platform roles and omits packaged developer tools without duplicate shortcuts', () => {
        for (const platform of ['darwin', 'win32', 'linux'] as const) {
            const items = flatten(menu({}, platform, true))
            expect(items.some((item) => item.role === 'toggleDevTools')).toBe(false)
            expect(items.some((item) => item.role === 'about')).toBe(true)
            expect(items.some((item) => item.role === 'quit')).toBe(true)
            expect(items.some((item) => item.role === 'services')).toBe(platform === 'darwin')
            const shortcuts = items.flatMap((item) =>
                item.accelerator ? [item.accelerator.toLowerCase()] : []
            )
            expect(new Set(shortcuts).size).toBe(shortcuts.length)
        }
    })
    it('rejects malformed or unbounded renderer menu state', () => {
        expect(menuStateSchema.safeParse({ ...initialMenuState, selectionCount: -1 }).success).toBe(
            false
        )
        expect(menuStateSchema.safeParse({ ...initialMenuState, command: 'clear' }).success).toBe(
            false
        )
    })
})
