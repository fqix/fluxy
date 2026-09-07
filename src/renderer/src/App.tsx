import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    Activity,
    ArrowDown,
    ArrowUp,
    Bookmark,
    ChevronDown,
    ChevronRight,
    Circle,
    Code2,
    FileText,
    Folder,
    Globe,
    Layers,
    LockKeyhole,
    Pause,
    Pin,
    Play,
    Plus,
    Search,
    Settings,
    Shield,
    SlidersHorizontal,
    Square,
    Terminal,
    Trash2,
    TriangleAlert,
    X,
    PanelLeft,
    PanelRight,
    PanelBottom,
    Send,
    Download,
    Upload,
    MoreHorizontal,
    Clock
} from 'lucide-react'
import {
    bytes,
    contentKind,
    toCurl,
    composeSchema,
    ruleSchema,
    type HighlightColor,
    type Snapshot,
    type Transaction
} from '../../shared/model'
import { Details, Inspector, type Run } from './Inspector'
import {
    MCPSettings,
    UpstreamSettings,
    ScriptingEditor,
    Certificates,
    Composer,
    DeveloperSetup,
    Preferences,
    RuleEditor,
    ruleNames,
    ToolWindow
} from './Tools'
import { TunSettingsPanel, HelperPanel } from './TunSettings'
import { Welcome } from './Welcome'
import {
    pruneBreakpointDrafts,
    BreakpointQueue,
    BreakpointTemplates,
    KeyboardShortcuts
} from './BreakpointTools'
import {
    ProjectManager,
    RequestNote,
    AutomaticSetup,
    InspectionSettings,
    PublishGist,
    ProtobufSettings,
    CustomCertificateSettings
} from './ParityTools'
import { workspaceSchema, type ProjectAction, type ProjectCatalog } from '../../shared/projects'
import { toolCommands, type MenuCommand, type MenuState } from '../../shared/menu'
import { Updates } from './Updates'
import { NetworkConditions } from './NetworkConditions'
import { DiffView } from './DiffView'
import { AdvancedFilters, useAdvancedFilter } from './AdvancedFilters'
import type { FilterRule } from '../../shared/filters'
import icon from '../../../resources/icon.png'

type Workspace = {
    id: string
    name: string
    advancedRules?: FilterRule[]
    advanced?: boolean
    method?: string
    status?: string
    domainFilter?: string
    clientFilter?: string
    isClosable?: boolean
    query: string
    filter: string
    scope: string
    searchBy: string
    selected: string[]
    muted: string[]
}
const newWorkspace = (number = 1): Workspace => ({
    id: crypto.randomUUID(),
    name: number === 1 ? 'All Traffic' : `Workspace ${number}`,
    isClosable: number !== 1,
    query: '',
    filter: 'All',
    scope: 'All Traffic',
    searchBy: 'URL',
    selected: [],
    muted: []
})
const filters = [
    'All',
    'HTTP',
    'HTTPS',
    'WebSocket',
    'AI API',
    'Web3',
    'RPC Error',
    'JSON',
    'XML',
    'JS',
    'CSS',
    'GraphQL',
    'Document',
    'Media',
    'Form',
    'Font',
    'Other',
    '1xx',
    '2xx',
    '3xx',
    '4xx',
    '5xx'
]
function filterMatch(t: Transaction, filter: string) {
    if (filter === 'All') return true
    if (/^[1-5]xx$/.test(filter)) return Math.floor((t.status ?? 0) / 100) === Number(filter[0])
    if (filter === 'HTTP' || filter === 'HTTPS') return t.protocol === filter
    if (filter === 'AI API')
        return /openai|anthropic|ollama|generativelanguage|\/chat\/completions|\/v1\/messages/.test(
            t.url
        )
    if (filter === 'Web3') return /"jsonrpc"\s*:/.test(t.requestBody)
    if (filter === 'RPC Error')
        return /"jsonrpc"\s*:/.test(t.requestBody) && /"error"\s*:/.test(t.responseBody)
    return contentKind(t) === filter
}
function iconFor(client: string) {
    return client === 'curl' || client === 'Python' ? (
        <Terminal size={13} />
    ) : client === 'Composer' ? (
        <Send size={13} />
    ) : (
        <Globe size={13} />
    )
}
function loadLocal<T>(key: string, fallback: T): T {
    try {
        return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback
    } catch {
        return fallback
    }
}
function legacyWorkspaces(): Workspace[] {
    const value = loadLocal<unknown>('fluxy-workspaces', [])
    if (!Array.isArray(value) || !value.length || value.length > 100) return [newWorkspace()]
    const tabs = value.map((w, i) => workspaceSchema.safeParse({ ...w, isClosable: i > 0 }))
    if (tabs.some((t) => !t.success)) return [newWorkspace()]
    return tabs.map((t) => ({ ...t.data!, selected: [] }))
}
export function App() {
    const [snapshot, setSnapshot] = useState<Snapshot>()
    const [error, setError] = useState('')
    const [toast, setToast] = useState('')
    const [busy, setBusy] = useState(0)
    const [workspaces, setWorkspaces] = useState<Workspace[]>(legacyWorkspaces)
    const [active, setActive] = useState(workspaces[0].id)
    const workspace = workspaces.find((w) => w.id === active) ?? workspaces[0]
    const [sidebarTab, setSidebarTab] = useState('Browse')
    const [sidebar, setSidebar] = useState(true)
    const [dock, setDock] = useState(false)
    const [networkURL, setNetworkURL] = useState<string>()
    const [ruleID, setRuleID] = useState<string>()
    const [inspector, setInspector] = useState(true)
    const [sidebarWidth, setSidebarWidth] = useState(() => loadLocal('fluxy-sidebar-width', 240))
    const [inspectorHeight, setInspectorHeight] = useState(() =>
        loadLocal('fluxy-inspector-height', 320)
    )
    const [tool, setTool] = useState<string>()
    const [projectName, setProjectName] = useState('')
    const [setupTarget, setSetupTarget] = useState('Terminal')
    const [p12Password, setP12Password] = useState('')
    const [workspaceProjectID, setWorkspaceProjectID] = useState('')
    const lastSavedTabs = useRef('')
    const setupChecked = useRef(false)
    const [composeTransaction, setComposeTransaction] = useState<Transaction>()
    const [workspaceName, setWorkspaceName] = useState('')
    const menuCommand = useRef<(command: MenuCommand) => void>(() => {})
    const [pendingMenuCommands, setPendingMenuCommands] = useState<MenuCommand[]>([])
    const [sessionName, setSessionName] = useState('Untitled Session')
    const [focusName, setFocusName] = useState('')
    const [focusSets, setFocusSets] = useState<
        { name: string; query: string; scope: string; filter: string }[]
    >(() => loadLocal('fluxy-focus', []))
    const [sidebarSearch, setSidebarSearch] = useState('')
    const [scrollTop, setScrollTop] = useState(0)
    const [viewHeight, setViewHeight] = useState(400)
    const [sort, setSort] = useState({ key: 'sequence', ascending: true })
    const advanced = workspace.advanced ?? false
    const setAdvanced = (value: boolean | ((old: boolean) => boolean)) =>
        patch({ advanced: typeof value === 'function' ? value(advanced) : value })
    const method = workspace.method ?? 'All methods'
    const setMethod = (value: string) => patch({ method: value })
    const status = workspace.status ?? 'All statuses'
    const setStatus = (value: string) => patch({ status: value })
    const [autoSelect, setAutoSelect] = useState(false)
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string }>()
    const [sectionClosed, setSectionClosed] = useState<string[]>([])
    const search = useRef<HTMLInputElement>(null)
    const table = useRef<HTMLDivElement>(null)
    const latest = useRef({ workspace, snapshot, tool })
    latest.current = { workspace, snapshot, tool }
    const refresh = useCallback(async () => {
        const next = await window.fluxy.snapshot()
        if (!next.projectsInitialized && !next.projectError) {
            const legacy = legacyWorkspaces()
            if (legacy.length) {
                const tabs = legacy.map((w, i) =>
                    workspaceSchema.parse({ ...w, isClosable: i !== 0 })
                )
                next.projects = await window.fluxy.project({
                    kind: 'tabs',
                    id: next.projects.activeID,
                    tabs,
                    activeTabID: tabs[0].id
                })
                next.projectsInitialized = true
            }
        }
        setSnapshot(next)
        if (!setupChecked.current) {
            setupChecked.current = true
            if (!next.settings.onboardingCompleted || next.settings.showWelcomeOnLaunch)
                setTool('Welcome to Fluxy')
        }
    }, [])
    const run: Run = useCallback(async (action, success) => {
        setBusy((n) => n + 1)
        try {
            await action()
            if (success) setToast(success)
        } catch (e) {
            setError(String(e).replace(/^Error: Error invoking remote method '[^']+': Error: /, ''))
        } finally {
            setBusy((n) => n - 1)
        }
    }, [])
    const patch = useCallback(
        (value: Partial<Workspace>) =>
            setWorkspaces((ws) =>
                ws.map((w) => (w.id === latest.current.workspace.id ? { ...w, ...value } : w))
            ),
        []
    )
    const openTool = useCallback((name: string) => {
        if (name === 'Compose') setComposeTransaction(undefined)
        setTool(name)
    }, [])
    const closeTool = useCallback(() => setTool(undefined), [])
    const addWorkspace = useCallback(
        () =>
            setWorkspaces((old) => {
                const w = newWorkspace(old.length + 1)
                setActive(w.id)
                return [...old, w]
            }),
        []
    )
    useEffect(() => {
        if (!window.fluxy) {
            setError('The desktop bridge is unavailable. Launch Fluxy using npm run dev.')
            return
        }
        void run(refresh)
        return window.fluxy.onEvent((event) => {
            if (event.type === 'state') {
                void run(refresh)
                return
            }
            if (event.type === 'log') {
                setSnapshot((s) => (s ? { ...s, logs: [...s.logs, event.log].slice(-2000) } : s))
                return
            }
            if (event.type === 'transaction') {
                setSnapshot((s) => {
                    if (!s) return s
                    const index = s.transactions.findIndex((t) => t.id === event.transaction.id)
                    const transactions = [...s.transactions]
                    if (index < 0) transactions.push(event.transaction)
                    else transactions[index] = event.transaction
                    const retained = new Set(
                        transactions
                            .filter((t) => t.state !== 'paused')
                            .slice(-s.settings.maxEntries)
                            .map((t) => t.id)
                    )
                    return {
                        ...s,
                        transactions: transactions.filter(
                            (t) => t.state === 'paused' || retained.has(t.id)
                        )
                    }
                })
                return
            }
            setPendingMenuCommands((commands) => [...commands, event.command])
        })
    }, [refresh, run, openTool, addWorkspace])
    useEffect(() => {
        localStorage.setItem(
            'fluxy-workspaces',
            JSON.stringify(workspaces.map((w) => ({ ...w, selected: [] })))
        )
    }, [workspaces])
    useEffect(() => {
        if (!snapshot || snapshot.projectError || workspaceProjectID === snapshot.projects.activeID)
            return
        const project = snapshot.projects.projects.find((p) => p.id === snapshot.projects.activeID)!
        const tabs = project.tabs.map((t) => ({ ...t, selected: [] }))
        setWorkspaces(tabs)
        setActive(project.activeTabID)
        setWorkspaceProjectID(project.id)
        lastSavedTabs.current = JSON.stringify({
            tabs: project.tabs,
            activeTabID: project.activeTabID
        })
    }, [snapshot?.projects, snapshot?.projectError, workspaceProjectID])
    const tabConfiguration = JSON.stringify({
        tabs: workspaces.map((w, index) =>
            workspaceSchema.parse({ ...w, isClosable: w.isClosable ?? index > 0 })
        ),
        activeTabID: active
    })
    useEffect(() => {
        if (
            !snapshot ||
            snapshot.projectError ||
            workspaceProjectID !== snapshot.projects.activeID ||
            tabConfiguration === lastSavedTabs.current
        )
            return
        const timer = setTimeout(() => {
            void window.fluxy
                .project({ kind: 'tabs', id: workspaceProjectID, ...JSON.parse(tabConfiguration) })
                .then(() => {
                    lastSavedTabs.current = tabConfiguration
                })
                .catch((e) => setError(String(e)))
        }, 150)
        return () => clearTimeout(timer)
    }, [tabConfiguration, workspaceProjectID, snapshot?.projects.activeID, snapshot?.projectError])
    useEffect(() => {
        localStorage.setItem('fluxy-focus', JSON.stringify(focusSets))
    }, [focusSets])
    useEffect(() => {
        if (!snapshot) return
        document.documentElement.dataset.theme = snapshot.settings.theme
        document.documentElement.style.setProperty('--font-size', `${snapshot.settings.fontSize}px`)
    }, [snapshot?.settings])
    useEffect(() => {
        if (!toast) return
        const timer = setTimeout(() => setToast(''), 3000)
        return () => clearTimeout(timer)
    }, [toast])
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (latest.current.tool) return
            if (e.key === 'Escape') setContextMenu(undefined)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [])
    useEffect(() => {
        if (snapshot) pruneBreakpointDrafts(snapshot.transactions)
    }, [snapshot?.transactions])
    const pausedCount = snapshot?.transactions.filter((t) => t.state === 'paused').length ?? 0
    const previousPaused = useRef(0)
    useEffect(() => {
        if (pausedCount > 0 && previousPaused.current === 0) setTool('Breakpoint Queue')
        previousPaused.current = pausedCount
    }, [pausedCount])
    const liveTransactions = snapshot?.transactions ?? []
    const liveIds = useMemo(
        () => new Set(liveTransactions.map((t) => t.id)),
        [snapshot?.transactions]
    )
    const transactions = useMemo(
        () => [
            ...new Map([
                ...(snapshot?.favorites ?? []).map((t) => [t.id, t] as const),
                ...liveTransactions.map((t) => [t.id, t] as const)
            ]).values()
        ],
        [snapshot?.favorites, snapshot?.transactions]
    )
    const domains = useMemo(
        () =>
            [
                ...transactions.reduce(
                    (m, t) => m.set(t.host, (m.get(t.host) ?? 0) + 1),
                    new Map<string, number>()
                )
            ].sort((a, b) => b[1] - a[1]),
        [transactions]
    )
    const clients = useMemo(
        () =>
            [
                ...transactions.reduce(
                    (m, t) => m.set(t.client, (m.get(t.client) ?? 0) + 1),
                    new Map<string, number>()
                )
            ].sort((a, b) => b[1] - a[1]),
        [transactions]
    )
    const advancedResult = useAdvancedFilter(transactions, workspace.advancedRules ?? [], advanced)
    const filtered = useMemo(
        () =>
            transactions
                .filter((t) => {
                    if (advancedResult.ids && !advancedResult.ids.has(t.id)) return false
                    const s = workspace.scope
                    if (!['Pinned', 'Saved', 'Notes'].includes(s) && !liveIds.has(t.id))
                        return false
                    if (s.startsWith('domain:') && t.host !== s.slice(7)) return false
                    if (s.startsWith('app:') && t.client !== s.slice(4)) return false
                    if (
                        (s === 'Pinned' && !t.pinned) ||
                        (s === 'Saved' && !t.saved) ||
                        (s === 'Notes' && !t.note)
                    )
                        return false
                    if (s === 'Errors' && !t.error && Number(t.status ?? 0) < 400) return false
                    if (s === 'Slow' && t.duration <= 1000) return false
                    if (s === 'WebSocket' && t.protocol !== 'WebSocket') return false
                    if (s === 'GraphQL' && contentKind(t) !== 'GraphQL') return false
                    if (s === 'Breakpoints' && t.state !== 'paused') return false
                    if (workspace.muted.includes(t.host)) return false
                    if (!filterMatch(t, workspace.filter)) return false
                    if (advanced && workspace.domainFilter && t.host !== workspace.domainFilter)
                        return false
                    if (advanced && workspace.clientFilter && t.client !== workspace.clientFilter)
                        return false
                    if (advanced && method !== 'All methods' && t.method !== method) return false
                    if (advanced && status !== 'All statuses' && !filterMatch(t, status))
                        return false
                    const haystack =
                        workspace.searchBy === 'URL'
                            ? t.url
                            : workspace.searchBy === 'Body'
                              ? `${t.requestBody}\n${t.responseBody}`
                              : workspace.searchBy === 'Headers'
                                ? JSON.stringify([t.requestHeaders, t.responseHeaders])
                                : workspace.searchBy === 'Method'
                                  ? t.method
                                  : `${t.url}\n${t.requestBody}\n${t.responseBody}\n${JSON.stringify(t.requestHeaders)}\n${JSON.stringify(t.responseHeaders)}`
                    return haystack.toLowerCase().includes(workspace.query.toLowerCase())
                })
                .sort((a, b) => {
                    const key = sort.key as keyof Transaction
                    const av = a[key] ?? '',
                        bv = b[key] ?? ''
                    return (
                        (typeof av === 'number' && typeof bv === 'number'
                            ? av - bv
                            : String(av).localeCompare(String(bv))) * (sort.ascending ? 1 : -1)
                    )
                }),
        [transactions, workspace, sort, advanced, method, status, advancedResult.ids]
    )
    const selected = transactions.find(
        (t) => t.id === workspace.selected[workspace.selected.length - 1]
    )
    useEffect(() => {
        if (autoSelect && filtered.length) {
            patch({ selected: [filtered[filtered.length - 1].id] })
            table.current?.scrollTo({ top: filtered.length * 26 })
        }
    }, [transactions.length, autoSelect])
    useEffect(() => {
        if (!table.current) return
        const observer = new ResizeObserver(([entry]) => setViewHeight(entry.contentRect.height))
        observer.observe(table.current)
        return () => observer.disconnect()
    }, [snapshot !== undefined])
    useEffect(() => {
        setScrollTop(0)
        if (table.current) table.current.scrollTop = 0
    }, [workspace.query, workspace.scope, workspace.filter, active])
    const resize = (event: React.PointerEvent, kind: 'sidebar' | 'inspector') => {
        event.preventDefault()
        const origin = kind === 'sidebar' ? event.clientX : event.clientY
        const initial = kind === 'sidebar' ? sidebarWidth : inspectorHeight
        const move = (e: PointerEvent) => {
            if (kind === 'sidebar')
                setSidebarWidth(Math.max(180, Math.min(380, initial + e.clientX - origin)))
            else
                setInspectorHeight(
                    Math.max(180, Math.min(window.innerHeight - 230, initial + origin - e.clientY))
                )
        }
        const end = () => {
            document.removeEventListener('pointermove', move)
            document.removeEventListener('pointerup', end)
        }
        document.addEventListener('pointermove', move)
        document.addEventListener('pointerup', end)
    }
    useEffect(() => {
        localStorage.setItem('fluxy-sidebar-width', JSON.stringify(sidebarWidth))
        localStorage.setItem('fluxy-inspector-height', JSON.stringify(inspectorHeight))
    }, [sidebarWidth, inspectorHeight])
    const choose = (t: Transaction, e: React.MouseEvent) => {
        if (e.shiftKey && workspace.selected.length) {
            const first = filtered.findIndex((v) => v.id === workspace.selected[0]),
                last = filtered.findIndex((v) => v.id === t.id)
            patch({
                selected: filtered
                    .slice(Math.max(0, Math.min(first, last)), Math.max(first, last) + 1)
                    .map((v) => v.id)
            })
        } else if (e.metaKey || e.ctrlKey)
            patch({
                selected: workspace.selected.includes(t.id)
                    ? workspace.selected.filter((id) => id !== t.id)
                    : [...workspace.selected, t.id]
            })
        else patch({ selected: [t.id] })
    }
    const errors = transactions.filter((t) => t.error || Number(t.status) >= 400).length
    const totalBytes = transactions.reduce((n, t) => n + t.requestBytes + t.responseBytes, 0)
    const start = Math.max(0, Math.floor(scrollTop / 26) - 10),
        end = Math.min(filtered.length, start + Math.ceil(viewHeight / 26) + 20)
    const editSelected = () => {
        setComposeTransaction(selected)
        setTool('Compose')
    }
    const selectedTransactions = transactions.filter((t) => workspace.selected.includes(t.id))
    const canReplay = Boolean(
        selected &&
        selected.protocol !== 'WebSocket' &&
        /^https?:/.test(selected.url) &&
        composeSchema.shape.method.safeParse(selected.method).success
    )
    const closeWorkspace = (id: string) => {
        if (workspaces.length <= 1 || workspaces.find((w) => w.id === id)?.isClosable === false)
            return
        const index = workspaces.findIndex((w) => w.id === id)
        const remaining = workspaces.filter((w) => w.id !== id)
        setWorkspaces(remaining)
        if (active === id) setActive(remaining[Math.max(0, index - 1)].id)
    }
    const flushProject = async () => {
        if (workspaceProjectID && !snapshot?.projectError) {
            await window.fluxy.project({
                kind: 'tabs',
                id: workspaceProjectID,
                ...JSON.parse(tabConfiguration)
            })
            lastSavedTabs.current = tabConfiguration
        }
    }
    const acceptCatalog = (catalog: ProjectCatalog) =>
        setSnapshot((s) => (s ? { ...s, projects: catalog, projectError: undefined } : s))
    const changeProject = async (action: ProjectAction) => {
        if (action.kind !== 'repair') await flushProject()
        acceptCatalog(await window.fluxy.project(action))
    }
    const diffFollowUp = (action: string, t: Transaction) => {
        if (action === 'Copy cURL') {
            void run(() => window.fluxy.copy(toCurl(t)))
            return
        }
        if (action === 'Export HAR') {
            void run(() => window.fluxy.exportHAR([t.id]))
            return
        }
        if (action === 'Replay') {
            void run(() => {
                if (
                    t.truncated ||
                    (t.requestBase64 &&
                        btoa(unescape(encodeURIComponent(t.requestBody))) !== t.requestBase64)
                )
                    throw new Error(
                        'This request contains a truncated or binary body. Use Edit & Repeat to prepare the body before sending.'
                    )
                return window.fluxy.compose({
                    url: t.url,
                    method: t.method,
                    headers: t.requestHeaders,
                    body: t.requestBody
                })
            })
            return
        }
        if (action === 'Edit & Repeat') {
            setComposeTransaction(t)
            setTool('Compose')
            return
        }
        patch({ selected: [t.id] })
        if (action === 'Network Conditions') {
            setNetworkURL(t.url)
            setTool(action)
            return
        }
        const kind =
            action === 'Map Local'
                ? 'mapLocal'
                : action === 'Map Remote'
                  ? 'mapRemote'
                  : 'breakpoint'
        void run(async () => {
            const id = crypto.randomUUID()
            await window.fluxy.rules([
                ...snapshot!.rules,
                ruleSchema.parse({
                    id,
                    name: `${action}: ${t.host}`,
                    kind,
                    enabled: kind === 'breakpoint',
                    pattern: t.url,
                    phase: 'both',
                    value: kind === 'mapRemote' ? t.url : ''
                })
            ])
            setRuleID(id)
            setSnapshot(await window.fluxy.snapshot())
            setTool(action)
        })
    }
    const exportProject = async () => {
        await flushProject()
        return window.fluxy.exportProject(snapshot!.projects.activeID)
    }
    const importProject = async () => {
        await flushProject()
        const result = await window.fluxy.importProject()
        if (result) acceptCatalog(result)
    }
    menuCommand.current = (command) => {
        if (!snapshot || tool || busy > 0) return
        if (command.startsWith('setup:')) {
            setSetupTarget(command.slice(6))
            openTool('Developer Setup')
            return
        }
        if (command.startsWith('project:')) {
            void run(() => changeProject({ kind: 'switch', id: command.slice(8) }))
            return
        }
        if (command.startsWith('highlight:')) {
            const color =
                command.slice(10) === 'none' ? null : (command.slice(10) as HighlightColor)
            void run(async () => {
                for (const t of selectedTransactions)
                    await window.fluxy.updateTransaction(t.id, { highlight: color })
            })
            return
        }
        switch (command) {
            case 'check-updates':
                setTool('Updates')
                void run(() => window.fluxy.update('check'))
                break
            case 'certificate-key':
                void run(() => window.fluxy.exportCertificateFormat('key'))
                break
            case 'certificate-p12':
                setP12Password('')
                setTool('Export P12')
                break
            case 'reset-certificates':
                void run(() => window.fluxy.resetCertificates())
                break
            case 'reset-helper':
                void run(() => window.fluxy.resetHelper())
                break
            case 'uninstall-helper':
                void run(() => window.fluxy.uninstallHelper())
                break
            case 'new-project':
                setProjectName('')
                setTool('New Project')
                break
            case 'rename-project':
                setProjectName(
                    snapshot.projects.projects.find((p) => p.id === snapshot.projects.activeID)!
                        .name
                )
                setTool('Rename Project')
                break
            case 'repair-project':
                setTool('Manage Projects')
                break
            case 'export-project':
                void run(exportProject)
                break
            case 'import-project':
                void run(importProject)
                break
            case 'new-session':
                void run(() => window.fluxy.clear())
                patch({ selected: [] })
                break
            case 'focus-url':
                patch({ searchBy: 'URL' })
                search.current?.focus()
                search.current?.select()
                break
            case 'note':
                if (selected) setTool('Add Note')
                break
            case 'delete-selected':
                void run(async () => {
                    await window.fluxy.deleteTransactions(selectedTransactions.map((t) => t.id))
                    patch({ selected: [] })
                })
                break
            case 'openapi-yaml':
            case 'openapi-html':
                void run(() =>
                    window.fluxy.exportOpenAPI(
                        command === 'openapi-yaml' ? 'yaml' : 'html',
                        (selectedTransactions.length ? selectedTransactions : liveTransactions).map(
                            (t) => t.id
                        )
                    )
                )
                break
            case 'start-proxy':
                void run(() => window.fluxy.start())
                break
            case 'stop-proxy':
                void run(() => window.fluxy.stop())
                break
            case 'external-proxy':
                void run(() =>
                    window.fluxy.settings({
                        ...snapshot.settings,
                        upstream: {
                            ...snapshot.settings.upstream,
                            enabled: !snapshot.settings.upstream.enabled
                        }
                    })
                )
                break
            case 'add-breakpoint':
                if (selected)
                    void run(async () => {
                        await window.fluxy.rules([
                            ...snapshot.rules,
                            ruleSchema.parse({
                                id: crypto.randomUUID(),
                                name: `Breakpoint ${selected.host}`,
                                kind: 'breakpoint',
                                enabled: true,
                                method: selected.method,
                                pattern: selected.url
                            })
                        ])
                        setTool('Breakpoint')
                    })
                break
            case 'automatic-setup':
                setTool('Automatic Setup')
                break
            case 'manual-setup':
                openTool('Developer Setup')
                break
            case 'certificate-pem':
                void run(() => window.fluxy.exportCertificateFormat('pem'))
                break
            case 'certificate-der':
                void run(() => window.fluxy.exportCertificateFormat('der'))
                break
            case 'debug-info':
                void run(
                    async () => window.fluxy.copy(await window.fluxy.debugInfo()),
                    'Debug info copied'
                )
                break
            case 'homepage':
            case 'repository':
            case 'docs':
            case 'issues':
            case 'changelog':
                void run(() => window.fluxy.openLink(command))
                break
            case 'new-workspace':
                addWorkspace()
                break
            case 'close-workspace':
                closeWorkspace(workspace.id)
                break
            case 'rename-workspace':
                setWorkspaceName(workspace.name)
                setTool('Rename Workspace')
                break
            case 'next-workspace':
            case 'previous-workspace': {
                const index = workspaces.findIndex((w) => w.id === workspace.id)
                setActive(
                    workspaces[
                        (index + (command === 'next-workspace' ? 1 : -1) + workspaces.length) %
                            workspaces.length
                    ].id
                )
                break
            }
            case 'sessions':
                setTool('Sessions')
                break
            case 'Save Session':
                setSessionName('Untitled Session')
                setTool('Save Session')
                break
            case 'toggle-proxy':
                void run(() => (snapshot.running ? window.fluxy.stop() : window.fluxy.start()))
                break
            case 'record':
                void run(() => window.fluxy.record(!snapshot.recording))
                break
            case 'clear':
                void run(() => window.fluxy.clear())
                break
            case 'clear-filters':
                void run(async () => {
                    await window.fluxy.clear()
                    patch({
                        query: '',
                        scope: 'All Traffic',
                        filter: 'All',
                        searchBy: 'URL',
                        advancedRules: [],
                        domainFilter: '',
                        clientFilter: '',
                        muted: [],
                        selected: []
                    })
                    setMethod('All methods')
                    setStatus('All statuses')
                    setAdvanced(false)
                })
                break
            case 'import':
                void run(() => window.fluxy.importHAR())
                break
            case 'export':
                void run(() => window.fluxy.exportHAR())
                break
            case 'export-selected':
                if (selectedTransactions.length)
                    void run(() => window.fluxy.exportHAR(selectedTransactions.map((t) => t.id)))
                break
            case 'sidebar':
                setSidebar((v) => !v)
                break
            case 'inspector':
                setInspector((v) => !v)
                break
            case 'dock':
                setDock((v) => !v)
                break
            case 'advanced':
                setAdvanced((v) => !v)
                break
            case 'auto-select':
                setAutoSelect((v) => !v)
                break
            case 'find':
                search.current?.focus()
                search.current?.select()
                break
            case 'first-request':
            case 'last-request': {
                const index = command === 'first-request' ? 0 : filtered.length - 1
                if (filtered[index]) {
                    setAutoSelect(false)
                    patch({ selected: [filtered[index].id] })
                    table.current?.scrollTo({ top: index * 26 })
                }
                break
            }
            case 'copy-url':
                if (selected) void run(() => window.fluxy.copy(selected.url), 'URL copied')
                break
            case 'copy-curl':
                if (selected) void run(() => window.fluxy.copy(toCurl(selected)), 'cURL copied')
                break
            case 'edit-resend':
                if (selected && canReplay) editSelected()
                break
            case 'repeat':
                if (selected && canReplay)
                    void run(
                        () =>
                            window.fluxy.compose(
                                composeSchema.parse({
                                    method: selected.method,
                                    url: selected.url,
                                    headers: selected.requestHeaders,
                                    body: selected.requestBody
                                })
                            ),
                        'Request repeated'
                    )
                break
            case 'pin':
                if (selected)
                    void run(() =>
                        window.fluxy.updateTransaction(selected.id, { pinned: !selected.pinned })
                    )
                break
            case 'save-request':
                if (selected)
                    void run(() =>
                        window.fluxy.updateTransaction(selected.id, { saved: !selected.saved })
                    )
                break
            case 'compare':
                if (selectedTransactions.length === 2) setTool('Compare Requests')
                break
            case 'system-proxy':
                void run(() => window.fluxy.systemProxy(!snapshot.systemProxy))
                break
            case 'no-cache':
                void run(() =>
                    window.fluxy.settings({
                        ...snapshot.settings,
                        noCache: !snapshot.settings.noCache
                    })
                )
                break
            case 'theme-system':
            case 'theme-light':
            case 'theme-dark':
                void run(() =>
                    window.fluxy.settings({
                        ...snapshot.settings,
                        theme:
                            command === 'theme-system'
                                ? 'system'
                                : command === 'theme-light'
                                  ? 'light'
                                  : 'dark'
                    })
                )
                break
            default:
                if ((toolCommands as readonly string[]).includes(command)) openTool(command)
        }
    }
    useEffect(() => {
        if (!pendingMenuCommands.length) return
        // A click can arrive before the main process receives our busy state.
        // Keep it until the active operation settles, then process one command
        // per render so subsequent commands see the resulting busy/modal state.
        if (tool || !snapshot) {
            setPendingMenuCommands([])
            return
        }
        if (busy > 0) return
        setPendingMenuCommands((commands) => commands.slice(1))
        menuCommand.current(pendingMenuCommands[0])
    }, [pendingMenuCommands, busy, tool, snapshot])
    const menuState: MenuState = {
        projects: snapshot?.projects.projects.map((p) => ({ id: p.id, name: p.name })) ?? [],
        activeProjectID: snapshot?.projects.activeID,
        projectError: Boolean(snapshot?.projectError),
        upstream: snapshot?.settings.upstream.enabled ?? false,
        ready: Boolean(snapshot),
        busy: busy > 0,
        modal: Boolean(tool),
        canCloseWorkspace: workspaces.length > 1 && workspace.isClosable !== false,
        selectionCount: selectedTransactions.length,
        canReplay,
        hasTraffic: Boolean(snapshot?.transactions.length),
        hasVisible: filtered.length > 0,
        pinned: selected?.pinned ?? false,
        saved: selected?.saved ?? false,
        sidebar,
        inspector,
        dock,
        advanced,
        autoSelect,
        running: snapshot?.running ?? false,
        recording: snapshot?.recording ?? true,
        systemProxy: snapshot?.systemProxy ?? false,
        captureMode: snapshot?.settings.captureMode ?? 'proxy',
        transportBusy: ['starting', 'stopping'].includes(snapshot?.tun.state ?? ''),
        noCache: snapshot?.settings.noCache ?? false,
        theme: snapshot?.settings.theme ?? 'system'
    }
    const menuStateKey = JSON.stringify(menuState)
    useEffect(() => {
        if (window.fluxy)
            void window.fluxy.menuState(JSON.parse(menuStateKey)).catch((e) => setError(String(e)))
    }, [menuStateKey])
    const setScope = (scope: string) => patch({ scope })
    const section = (title: string, children: React.ReactNode, count?: number) => (
        <div className="sidebar-section">
            <button
                className="section-heading"
                onClick={() =>
                    setSectionClosed((v) =>
                        v.includes(title) ? v.filter((s) => s !== title) : [...v, title]
                    )
                }
            >
                {sectionClosed.includes(title) ? (
                    <ChevronRight size={12} />
                ) : (
                    <ChevronDown size={12} />
                )}
                <span>{title}</span>
                <small>{count}</small>
            </button>
            {!sectionClosed.includes(title) && children}
        </div>
    )
    const nav = (title: string, key: string, icon: React.ReactNode, count?: number) => (
        <button
            key={key}
            className={`nav-row ${workspace.scope === key ? 'selected' : ''}`}
            onClick={() => setScope(key)}
            title={title}
        >
            {icon}
            <span>{title}</span>
            <small>{count ?? ''}</small>
        </button>
    )
    if (!snapshot)
        return (
            <div className="loading">
                <img src={icon} />
                <h2>Fluxy</h2>
                <p>{error || 'Opening workspace…'}</p>
            </div>
        )
    return (
        <div className="app" onClick={() => contextMenu && setContextMenu(undefined)}>
            <div className="titlebar">
                <div className="titlebar-left" style={{ width: sidebar ? sidebarWidth : 104 }}>
                    <button title="Toggle sidebar" onClick={() => setSidebar((v) => !v)}>
                        <PanelLeft size={18} />
                    </button>
                </div>
                <strong className="workspace-title">
                    {workspace.scope.replace(/^(domain|app):/, '')}
                </strong>
                <button
                    className="proxy-pill"
                    title="Proxy status and connection setup"
                    aria-label="Proxy status and connection setup"
                    onClick={() => setTool('Connection')}
                >
                    <span className={`dot ${snapshot.running ? 'green' : ''}`} />
                    <span>
                        Fluxy{' '}
                        {snapshot.settings.captureMode === 'tun'
                            ? `TUN (${snapshot.tun.state})`
                            : ''}{' '}
                        | {snapshot.settings.localhostOnly ? '127.0.0.1' : '0.0.0.0'}:
                        {snapshot.settings.port} | {snapshot.running ? 'Running' : 'Stopped'}
                    </span>
                </button>
                <div className="window-actions">
                    <button
                        title={snapshot.running ? 'Stop proxy' : 'Start proxy'}
                        disabled={busy > 0}
                        onClick={() =>
                            void run(() =>
                                snapshot.running ? window.fluxy.stop() : window.fluxy.start()
                            )
                        }
                    >
                        {snapshot.running ? (
                            <Square size={16} fill="currentColor" />
                        ) : (
                            <Play size={17} fill="currentColor" />
                        )}
                    </button>
                    <button
                        title={snapshot.recording ? 'Pause recording' : 'Resume recording'}
                        onClick={() => void run(() => window.fluxy.record(!snapshot.recording))}
                    >
                        {snapshot.recording ? (
                            <Circle
                                size={14}
                                className={snapshot.running ? 'red' : ''}
                                fill="currentColor"
                            />
                        ) : (
                            <Pause size={17} />
                        )}
                    </button>
                    <button title="Compose request" onClick={() => openTool('Compose')}>
                        <Code2 size={18} />
                    </button>
                    <i />
                    <button
                        title="Toggle bottom inspector"
                        className={inspector && selected ? 'blue' : ''}
                        onClick={() => setInspector((v) => !v)}
                    >
                        <PanelBottom size={18} />
                    </button>
                    <button
                        title="Toggle context dock"
                        className={dock ? 'blue' : ''}
                        onClick={() => setDock((v) => !v)}
                    >
                        <PanelRight size={18} />
                    </button>
                </div>
            </div>
            <div className="app-body">
                {sidebar && (
                    <>
                        <aside className="sidebar" style={{ width: sidebarWidth }}>
                            <div className="sidebar-tabs segmented">
                                {['Browse', 'Focus', 'Library'].map((tab) => (
                                    <button
                                        key={tab}
                                        className={sidebarTab === tab ? 'active' : ''}
                                        onClick={() => setSidebarTab(tab)}
                                    >
                                        {tab}
                                    </button>
                                ))}
                            </div>
                            <div className="sidebar-scroll">
                                {sidebarTab === 'Browse' && (
                                    <>
                                        <div className="section-label">All</div>
                                        {nav(
                                            'All Traffic',
                                            'All Traffic',
                                            <Activity size={15} />,
                                            transactions.length
                                        )}
                                        {section(
                                            'Apps',
                                            clients
                                                .filter(([c]) =>
                                                    c
                                                        .toLowerCase()
                                                        .includes(sidebarSearch.toLowerCase())
                                                )
                                                .map(([c, n]) =>
                                                    nav(
                                                        c,
                                                        `app:${c}`,
                                                        <span
                                                            className={`app-icon ${c === 'Google Chrome' ? 'chrome' : ''}`}
                                                        >
                                                            {iconFor(c)}
                                                        </span>,
                                                        n
                                                    )
                                                ),
                                            clients.length
                                        )}
                                        {section(
                                            'Domains',
                                            domains
                                                .filter(([host]) =>
                                                    host.includes(sidebarSearch.toLowerCase())
                                                )
                                                .map(([host, n]) =>
                                                    nav(
                                                        host,
                                                        `domain:${host}`,
                                                        <Globe size={14} />,
                                                        n
                                                    )
                                                ),
                                            domains.length
                                        )}
                                        <div className="section-label">Signals</div>
                                        {nav(
                                            'Errors',
                                            'Errors',
                                            <TriangleAlert size={15} />,
                                            errors
                                        )}
                                        {nav(
                                            'Slow',
                                            'Slow',
                                            <Clock size={15} />,
                                            transactions.filter((t) => t.duration > 1000).length
                                        )}
                                        {nav(
                                            'WebSocket',
                                            'WebSocket',
                                            <Activity size={15} />,
                                            transactions.filter((t) => t.protocol === 'WebSocket')
                                                .length
                                        )}
                                        {nav(
                                            'GraphQL',
                                            'GraphQL',
                                            <Layers size={15} />,
                                            transactions.filter((t) => contentKind(t) === 'GraphQL')
                                                .length
                                        )}
                                        {nav(
                                            'Breakpoints',
                                            'Breakpoints',
                                            <Pause size={15} />,
                                            transactions.filter((t) => t.state === 'paused').length
                                        )}
                                    </>
                                )}
                                {sidebarTab === 'Library' && (
                                    <>
                                        <div className="section-label">Favorites</div>
                                        {nav(
                                            'Pinned',
                                            'Pinned',
                                            <Pin size={15} />,
                                            transactions.filter((t) => t.pinned).length
                                        )}
                                        {nav(
                                            'Saved',
                                            'Saved',
                                            <Bookmark size={15} />,
                                            transactions.filter((t) => t.saved).length
                                        )}
                                        {nav(
                                            'Notes',
                                            'Notes',
                                            <FileText size={15} />,
                                            transactions.filter((t) => t.note).length
                                        )}
                                        <div className="section-label">Sessions</div>
                                        {snapshot.sessions.map((s) => (
                                            <div className="session-row" key={s.id}>
                                                <button
                                                    title={`${s.count} requests · ${new Date(s.createdAt).toLocaleString()}`}
                                                    onClick={() => {
                                                        setSessionName(s.id)
                                                        setTool('Open Session')
                                                    }}
                                                >
                                                    <Folder size={15} />
                                                    <span>{s.name}</span>
                                                    <small>{s.count}</small>
                                                </button>
                                                <button
                                                    title="Delete session"
                                                    onClick={() => {
                                                        setSessionName(s.id)
                                                        setTool('Delete Session')
                                                    }}
                                                >
                                                    <Trash2 size={12} />
                                                </button>
                                            </div>
                                        ))}
                                        <button
                                            className="nav-row"
                                            onClick={() => {
                                                setSessionName('Untitled Session')
                                                setTool('Save Session')
                                            }}
                                        >
                                            <Plus size={14} />
                                            Save Current Session
                                        </button>
                                    </>
                                )}
                                {sidebarTab === 'Focus' && (
                                    <>
                                        <div className="section-label">Focus Sets</div>
                                        <p className="sidebar-help">
                                            Save the current scope and filters for your next
                                            investigation.
                                        </p>
                                        {focusSets.map((f, i) => (
                                            <div className="session-row" key={i}>
                                                <button onClick={() => patch(f)}>
                                                    <Layers size={14} />
                                                    <span>{f.name}</span>
                                                </button>
                                                <button
                                                    title="Delete focus set"
                                                    onClick={() =>
                                                        setFocusSets(
                                                            focusSets.filter((_, n) => n !== i)
                                                        )
                                                    }
                                                >
                                                    <X size={12} />
                                                </button>
                                            </div>
                                        ))}
                                        <button
                                            className="nav-row"
                                            onClick={() => {
                                                setFocusName('')
                                                setTool('Save Focus Set')
                                            }}
                                        >
                                            <Plus size={14} />
                                            Save Current Focus
                                        </button>
                                        <div className="section-label">Noise Control</div>
                                        <p className="sidebar-help">
                                            Muted domains remain captured and are hidden in this
                                            workspace.
                                        </p>
                                        {workspace.muted.map((host) => (
                                            <div className="session-row" key={host}>
                                                <span>{host}</span>
                                                <button
                                                    title="Unmute domain"
                                                    onClick={() =>
                                                        patch({
                                                            muted: workspace.muted.filter(
                                                                (h) => h !== host
                                                            )
                                                        })
                                                    }
                                                >
                                                    <X size={12} />
                                                </button>
                                            </div>
                                        ))}
                                        {selected && (
                                            <button
                                                className="nav-row"
                                                onClick={() =>
                                                    patch({
                                                        muted: [
                                                            ...new Set([
                                                                ...workspace.muted,
                                                                selected.host
                                                            ])
                                                        ]
                                                    })
                                                }
                                            >
                                                <Plus size={14} />
                                                Mute {selected.host}
                                            </button>
                                        )}
                                    </>
                                )}
                            </div>
                            <div className="sidebar-footer">
                                <button title="New workspace" onClick={addWorkspace}>
                                    <Plus size={16} />
                                </button>
                                <Search size={12} />
                                <input
                                    aria-label="Filter sidebar"
                                    placeholder="Filter"
                                    value={sidebarSearch}
                                    onChange={(e) => setSidebarSearch(e.target.value)}
                                />
                                <button title="Settings" onClick={() => setTool('Settings')}>
                                    <Settings size={14} />
                                </button>
                            </div>
                        </aside>
                        <div
                            className="vertical-resizer"
                            role="separator"
                            aria-label="Resize sidebar"
                            onPointerDown={(e) => resize(e, 'sidebar')}
                        />
                    </>
                )}
                <main className="workspace">
                    <div className="workspace-tabs">
                        {workspaces.map((w) => (
                            <div className={w.id === active ? 'active' : ''} key={w.id}>
                                <button onClick={() => setActive(w.id)}>
                                    <Activity size={12} />
                                    {w.name}
                                </button>
                                {workspaces.length > 1 && w.isClosable !== false && (
                                    <button
                                        title="Close workspace"
                                        onClick={() => closeWorkspace(w.id)}
                                    >
                                        <X size={11} />
                                    </button>
                                )}
                            </div>
                        ))}
                        <button title="New workspace" onClick={addWorkspace}>
                            <Plus size={13} />
                        </button>
                    </div>
                    <nav className="filter-tabs">
                        {filters.map((f) => (
                            <button
                                className={workspace.filter === f ? 'active' : ''}
                                key={f}
                                onClick={() => patch({ filter: f })}
                            >
                                {f}
                            </button>
                        ))}
                    </nav>
                    <div className="search-row">
                        <span
                            title={snapshot.recording ? 'Recording enabled' : 'Recording paused'}
                            className={`capture-check ${snapshot.recording ? '' : 'paused'}`}
                        >
                            ✓
                        </span>
                        <select
                            aria-label="Search field"
                            value={workspace.searchBy}
                            onChange={(e) => patch({ searchBy: e.target.value })}
                        >
                            {['URL', 'Headers', 'Body', 'Method', 'All fields'].map((f) => (
                                <option key={f}>{f}</option>
                            ))}
                        </select>
                        <div className="search-input">
                            <input
                                ref={search}
                                aria-label="Search traffic"
                                placeholder="Search…"
                                value={workspace.query}
                                onChange={(e) => patch({ query: e.target.value })}
                            />
                            {workspace.query && (
                                <button title="Clear search" onClick={() => patch({ query: '' })}>
                                    <X size={12} />
                                </button>
                            )}
                        </div>
                        <button
                            className={advanced ? 'blue' : ''}
                            onClick={() => setAdvanced((v) => !v)}
                        >
                            <Plus size={12} />
                            Add Filter
                        </button>
                        <button
                            title="Toggle auto select"
                            className={autoSelect ? 'blue' : ''}
                            onClick={() => setAutoSelect((v) => !v)}
                        >
                            <SlidersHorizontal size={14} />
                        </button>
                    </div>
                    {advanced && (
                        <div className="advanced-filters">
                            <select
                                aria-label="Filter domain"
                                value={workspace.domainFilter ?? ''}
                                onChange={(e) => patch({ domainFilter: e.target.value })}
                            >
                                <option value="">All domains</option>
                                {domains.map(([host]) => (
                                    <option key={host}>{host}</option>
                                ))}
                            </select>
                            <select
                                aria-label="Filter app"
                                value={workspace.clientFilter ?? ''}
                                onChange={(e) => patch({ clientFilter: e.target.value })}
                            >
                                <option value="">All apps</option>
                                {clients.map(([client]) => (
                                    <option key={client}>{client}</option>
                                ))}
                            </select>
                            <select
                                aria-label="Filter method"
                                value={method}
                                onChange={(e) => setMethod(e.target.value)}
                            >
                                {[
                                    'All methods',
                                    'GET',
                                    'POST',
                                    'PUT',
                                    'PATCH',
                                    'DELETE',
                                    'CONNECT',
                                    'OPTIONS'
                                ].map((v) => (
                                    <option key={v}>{v}</option>
                                ))}
                            </select>
                            <select
                                aria-label="Filter status"
                                value={status}
                                onChange={(e) => setStatus(e.target.value)}
                            >
                                {['All statuses', '2xx', '3xx', '4xx', '5xx'].map((v) => (
                                    <option key={v}>{v}</option>
                                ))}
                            </select>
                            <button
                                onClick={() => {
                                    patch({ domainFilter: '', clientFilter: '', advancedRules: [] })
                                    setMethod('All methods')
                                    setStatus('All statuses')
                                    setAdvanced(false)
                                }}
                            >
                                Reset Filters
                            </button>
                        </div>
                    )}
                    {advanced && (
                        <AdvancedFilters
                            rules={workspace.advancedRules ?? []}
                            change={(advancedRules) => patch({ advancedRules })}
                        />
                    )}
                    {advanced && advancedResult.error && <p role="alert">{advancedResult.error}</p>}
                    <div
                        className="traffic-table"
                        ref={table}
                        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
                        tabIndex={0}
                        aria-label="Captured requests"
                        onKeyDown={(e) => {
                            if (!['ArrowDown', 'ArrowUp'].includes(e.key) || !filtered.length)
                                return
                            e.preventDefault()
                            const index = filtered.findIndex((t) => t.id === selected?.id)
                            const next = Math.max(
                                0,
                                Math.min(
                                    filtered.length - 1,
                                    index + (e.key === 'ArrowDown' ? 1 : -1)
                                )
                            )
                            patch({ selected: [filtered[next].id] })
                            const offset = next * 26
                            if (
                                table.current &&
                                (offset < scrollTop || offset > scrollTop + viewHeight - 65)
                            )
                                table.current.scrollTop = Math.max(0, offset - viewHeight / 2)
                        }}
                    >
                        <table>
                            <colgroup>
                                <col style={{ width: 24 }} />
                                <col style={{ width: 46 }} />
                                <col style={{ width: '36%' }} />
                                <col style={{ width: 160 }} />
                                <col style={{ width: 55 }} />
                                <col style={{ width: 68 }} />
                                <col style={{ width: 85 }} />
                                <col style={{ width: 75 }} />
                                <col style={{ width: 110 }} />
                                <col style={{ width: 75 }} />
                                <col style={{ width: 75 }} />
                                <col style={{ width: 40 }} />
                                {snapshot.settings.headerColumns.map((c) => (
                                    <col key={c.id} style={{ width: 150 }} />
                                ))}
                            </colgroup>
                            <thead>
                                <tr>
                                    {[
                                        ['', ''],
                                        ['ID', 'sequence'],
                                        ['URL', 'url'],
                                        ['Client', 'client'],
                                        ['Code', 'status'],
                                        ['Method', 'method'],
                                        ['Time', 'timestamp'],
                                        ['Duration', 'duration'],
                                        ['Status', 'state'],
                                        ['Request', 'requestBytes'],
                                        ['Response', 'responseBytes'],
                                        ['SSL', 'ssl']
                                    ].map(([title, key], i) => (
                                        <th
                                            key={i}
                                            onClick={() =>
                                                key &&
                                                setSort((s) => ({
                                                    key,
                                                    ascending: s.key === key ? !s.ascending : true
                                                }))
                                            }
                                        >
                                            {title}
                                            {sort.key === key && (
                                                <span className="sort-mark">
                                                    {sort.ascending ? '⌃' : '⌄'}
                                                </span>
                                            )}
                                        </th>
                                    ))}
                                    {snapshot.settings.headerColumns.map((c) => (
                                        <th key={c.id}>{c.name}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {start > 0 && (
                                    <tr className="spacer">
                                        <td
                                            colSpan={12 + snapshot.settings.headerColumns.length}
                                            style={{ height: start * 26 }}
                                        />
                                    </tr>
                                )}
                                {filtered.slice(start, end).map((t) => (
                                    <tr
                                        key={t.id}
                                        data-request-id={t.id}
                                        data-highlight={t.highlight ?? undefined}
                                        className={`${workspace.selected.includes(t.id) ? 'selected' : ''} ${t.state === 'paused' ? 'paused-row' : ''}`}
                                        onClick={(e) => choose(t, e)}
                                        onDoubleClick={() => {
                                            setComposeTransaction(t)
                                            setTool('Compose')
                                        }}
                                        onContextMenu={(e) => {
                                            e.preventDefault()
                                            patch({ selected: [t.id] })
                                            setContextMenu({
                                                x: Math.min(e.clientX, window.innerWidth - 210),
                                                y: Math.min(e.clientY, window.innerHeight - 220),
                                                id: t.id
                                            })
                                        }}
                                    >
                                        <td>
                                            <span
                                                className={`dot ${t.error || Number(t.status) >= 500 ? 'red' : Number(t.status) >= 400 || t.state === 'paused' ? 'orange' : Number(t.status) >= 300 ? 'blue' : 'green'}`}
                                            />
                                        </td>
                                        <td className="muted numeric">{t.sequence}</td>
                                        <td className="url-cell" title={t.url}>
                                            {t.pinned && <Pin size={10} />}
                                            {t.host}
                                            {t.path}
                                        </td>
                                        <td>
                                            <span
                                                className="client-cell"
                                                title={`${t.clientSource ?? 'unknown'}${t.clientPID ? ` · PID ${t.clientPID}` : ''}${t.clientIdentity ? ` · ${t.clientIdentity}` : ''}`}
                                            >
                                                <span
                                                    className={`app-icon tiny ${t.client === 'Google Chrome' ? 'chrome' : ''}`}
                                                >
                                                    {iconFor(t.client)}
                                                </span>
                                                {t.client}
                                            </span>
                                        </td>
                                        <td
                                            className={`code ${Number(t.status) >= 400 ? 'orange' : 'green'}`}
                                        >
                                            {t.status ?? '—'}
                                        </td>
                                        <td className={`method ${t.method.toLowerCase()}`}>
                                            {t.method}
                                        </td>
                                        <td className="muted numeric">
                                            {new Date(t.timestamp).toLocaleTimeString('en-GB')}
                                        </td>
                                        <td className="muted numeric">
                                            {t.duration ? `${t.duration} ms` : '—'}
                                        </td>
                                        <td>
                                            <span
                                                className={
                                                    t.state === 'error'
                                                        ? 'error-status'
                                                        : t.state === 'paused'
                                                          ? 'paused-status'
                                                          : 'muted'
                                                }
                                            >
                                                {t.error
                                                    ? 'Error'
                                                    : t.state === 'completed'
                                                      ? 'Completed'
                                                      : t.state === 'paused'
                                                        ? 'Breakpoint'
                                                        : t.state === 'blocked'
                                                          ? 'Blocked'
                                                          : 'Pending'}
                                            </span>
                                        </td>
                                        <td className="muted numeric">{bytes(t.requestBytes)}</td>
                                        <td className="muted numeric">{bytes(t.responseBytes)}</td>
                                        <td>
                                            <LockKeyhole
                                                size={11}
                                                className={t.ssl ? 'green' : 'muted'}
                                            />
                                        </td>
                                        {snapshot.settings.headerColumns.map((c) => (
                                            <td key={c.id}>
                                                {(c.source === 'request'
                                                    ? t.requestHeaders
                                                    : t.responseHeaders)[c.header.toLowerCase()] ??
                                                    '—'}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                                {end < filtered.length && (
                                    <tr className="spacer">
                                        <td
                                            colSpan={12 + snapshot.settings.headerColumns.length}
                                            style={{ height: (filtered.length - end) * 26 }}
                                        />
                                    </tr>
                                )}
                            </tbody>
                        </table>
                        {filtered.length === 0 && (
                            <div className="traffic-empty">
                                <div className="empty-icon">
                                    <Activity size={36} strokeWidth={1.1} />
                                </div>
                                <h2>
                                    {transactions.length
                                        ? 'No matching requests'
                                        : snapshot.running
                                          ? 'Listening for traffic'
                                          : 'Ready to capture traffic'}
                                </h2>
                                <p>
                                    {transactions.length
                                        ? 'Adjust your filters or select a different scope.'
                                        : `HTTP & HTTPS proxy · 127.0.0.1:${snapshot.settings.port}`}
                                </p>
                                <div className="button-row">
                                    {!snapshot.running && (
                                        <button
                                            className="primary"
                                            disabled={busy > 0}
                                            onClick={() => void run(() => window.fluxy.start())}
                                        >
                                            <Play size={13} fill="currentColor" />
                                            Start Capture
                                        </button>
                                    )}
                                    <button onClick={() => setTool('Developer Setup')}>
                                        Open Developer Setup
                                    </button>
                                </div>
                                <span className="muted">
                                    {transactions.length
                                        ? `${transactions.length} requests in this session`
                                        : 'Configure a client to start inspecting requests.'}
                                </span>
                            </div>
                        )}
                    </div>
                    {inspector && selected && (
                        <>
                            <div
                                className="horizontal-resizer"
                                role="separator"
                                aria-label="Resize inspector"
                                onPointerDown={(e) => resize(e, 'inspector')}
                            />
                            <div
                                className="inspector-container"
                                style={{ height: inspectorHeight }}
                            >
                                <Inspector
                                    previewTabs={snapshot.settings.previewTabs}
                                    protobufType={snapshot.settings.protobufType}
                                    t={selected}
                                    run={run}
                                    close={() => setInspector(false)}
                                    compose={editSelected}
                                />
                            </div>
                        </>
                    )}
                    <footer className="statusbar">
                        <button onClick={() => void run(() => window.fluxy.clear())}>Clear</button>
                        <button
                            className={autoSelect ? 'selected' : ''}
                            onClick={() => setAutoSelect((v) => !v)}
                        >
                            Auto Select
                        </button>
                        <span className="selection-count">
                            {workspace.selected.length}/{filtered.length} rows selected
                        </span>
                        <span className="selected-request">
                            {selected
                                ? `${selected.method} ${selected.path}`
                                : 'No request selected'}
                        </span>
                        <button className="red" onClick={() => setScope('Errors')}>
                            <TriangleAlert size={11} />
                            {errors} errors
                        </button>
                        <span>{bytes(totalBytes)} total</span>
                        <button
                            title="Export HAR"
                            onClick={() => void run(() => window.fluxy.exportHAR())}
                        >
                            <Download size={13} />
                        </button>
                        <button
                            title="Import HAR"
                            onClick={() => void run(() => window.fluxy.importHAR())}
                        >
                            <Upload size={13} />
                        </button>
                        <button title="Proxy logs" onClick={() => setTool('Logs')}>
                            <Terminal size={13} />
                        </button>
                    </footer>
                    <div className="rules-bar">
                        {['available', 'downloaded'].includes(snapshot.update.phase) && (
                            <button className="enabled" onClick={() => setTool('Updates')}>
                                {snapshot.update.phase === 'downloaded'
                                    ? 'Install Update'
                                    : 'Update Available'}
                            </button>
                        )}
                        {[
                            'Block List',
                            'Allow List',
                            'Map Local',
                            'Map Remote',
                            'Modify Headers',
                            'Breakpoint',
                            'Network Conditions'
                        ].map((title) => (
                            <button
                                key={title}
                                className={
                                    snapshot.rules.some(
                                        (r) => ruleNames[r.kind] === title && r.enabled
                                    )
                                        ? 'enabled'
                                        : ''
                                }
                                onClick={() => setTool(title)}
                            >
                                {title}
                                {snapshot.rules.filter(
                                    (r) => ruleNames[r.kind] === title && r.enabled
                                ).length > 0 &&
                                    ` · ${snapshot.rules.filter((r) => ruleNames[r.kind] === title && r.enabled).length}`}
                            </button>
                        ))}
                        <button
                            onClick={() => setTool('SSL Proxying')}
                            className={snapshot.settings.ssl ? 'enabled' : ''}
                        >
                            SSL Proxying
                        </button>
                        <button
                            onClick={() => setTool('Scripting')}
                            className={snapshot.scripts.some((s) => s.enabled) ? 'enabled' : ''}
                        >
                            Scripting
                        </button>
                        <button
                            title="Compare selected requests"
                            disabled={workspace.selected.length !== 2}
                            onClick={() => setTool('Compare Requests')}
                        >
                            Compare
                        </button>
                    </div>
                </main>
                {dock && (
                    <aside className="context-dock">
                        <div className="dock-tabs segmented">
                            <strong>Details</strong>
                        </div>
                        <Details t={selected} run={run} />
                    </aside>
                )}
            </div>
            {tool === 'Welcome to Fluxy' && (
                <Welcome
                    snapshot={snapshot}
                    close={closeTool}
                    developerSetup={() => setTool('Developer Setup')}
                />
            )}
            {tool && tool !== 'Welcome to Fluxy' && (
                <ToolWindow title={tool} close={closeTool}>
                    {tool === 'Custom Certificates' ? (
                        <CustomCertificateSettings snapshot={snapshot} run={run} />
                    ) : tool === 'Export P12' ? (
                        <form
                            className="settings-form"
                            onSubmit={(e) => {
                                e.preventDefault()
                                void run(async () => {
                                    const path = await window.fluxy.exportCertificateFormat(
                                        'p12',
                                        p12Password
                                    )
                                    if (path) {
                                        setP12Password('')
                                        closeTool()
                                    }
                                })
                            }}
                        >
                            <label>
                                Archive password
                                <input
                                    aria-label="P12 password"
                                    type="password"
                                    value={p12Password}
                                    onChange={(e) => setP12Password(e.target.value)}
                                />
                            </label>
                            <button className="primary" disabled={!p12Password}>
                                Export P12
                            </button>
                        </form>
                    ) : tool === 'Automatic Setup' ? (
                        <AutomaticSetup snapshot={snapshot} run={run} />
                    ) : tool === 'Protobuf' ? (
                        <ProtobufSettings snapshot={snapshot} run={run} />
                    ) : tool === 'Publish Selected to Gist' ? (
                        <PublishGist ids={selectedTransactions.map((t) => t.id)} run={run} />
                    ) : [
                          'Full Proxy Bypass',
                          'Inspector Preview Tabs',
                          'Custom Header Columns'
                      ].includes(tool) ? (
                        <InspectionSettings title={tool} snapshot={snapshot} run={run} />
                    ) : tool === 'Breakpoint Queue' ? (
                        <BreakpointQueue snapshot={snapshot} run={run} />
                    ) : tool === 'Breakpoint Templates' ? (
                        <BreakpointTemplates snapshot={snapshot} run={run} />
                    ) : tool === 'Keyboard Shortcuts' ? (
                        <KeyboardShortcuts run={run} />
                    ) : tool === 'Manage Projects' ? (
                        <ProjectManager
                            snapshot={snapshot}
                            run={run}
                            change={changeProject}
                            exportProject={exportProject}
                            importProject={importProject}
                        />
                    ) : tool === 'New Project' || tool === 'Rename Project' ? (
                        <form
                            className="settings-form"
                            onSubmit={(e) => {
                                e.preventDefault()
                                void run(async () => {
                                    await changeProject(
                                        tool === 'New Project'
                                            ? { kind: 'create', name: projectName }
                                            : {
                                                  kind: 'rename',
                                                  id: snapshot.projects.activeID,
                                                  name: projectName
                                              }
                                    )
                                    closeTool()
                                })
                            }}
                        >
                            <label>
                                Project name
                                <input
                                    autoFocus
                                    aria-label="Project name"
                                    maxLength={100}
                                    value={projectName}
                                    onChange={(e) => setProjectName(e.target.value)}
                                />
                            </label>
                            <button className="primary" disabled={!projectName.trim()}>
                                {tool === 'New Project' ? 'Create Project' : 'Rename Project'}
                            </button>
                        </form>
                    ) : tool === 'Add Note' && selected ? (
                        <RequestNote transaction={selected} run={run} close={closeTool} />
                    ) : tool === 'Updates' ? (
                        <Updates snapshot={snapshot} run={run} />
                    ) : tool === 'Diff' ? (
                        <DiffView transactions={transactions} followUp={diffFollowUp} />
                    ) : tool === 'Network Conditions' ? (
                        <NetworkConditions
                            snapshot={snapshot}
                            run={run}
                            initialURL={networkURL ?? selected?.url}
                        />
                    ) : Object.values(ruleNames).includes(tool) ? (
                        <RuleEditor title={tool} snapshot={snapshot} run={run} initialID={ruleID} />
                    ) : tool === 'Compose' ? (
                        <Composer transaction={composeTransaction} run={run} />
                    ) : tool === 'Settings' || tool === 'SSL Proxying' ? (
                        <Preferences snapshot={snapshot} run={run} ssl={tool === 'SSL Proxying'} />
                    ) : tool === 'Upstream Proxy' ? (
                        <UpstreamSettings snapshot={snapshot} run={run} />
                    ) : tool === 'Scripting' ? (
                        <ScriptingEditor snapshot={snapshot} run={run} />
                    ) : tool === 'MCP Server' ? (
                        <MCPSettings snapshot={snapshot} run={run} />
                    ) : tool === 'Certificates' ? (
                        <Certificates snapshot={snapshot} run={run} />
                    ) : tool === 'Developer Setup' ? (
                        <DeveloperSetup
                            key={setupTarget}
                            snapshot={snapshot}
                            run={run}
                            initialTarget={setupTarget}
                        />
                    ) : tool === 'Helper Tool' ? (
                        <HelperPanel snapshot={snapshot} run={run} />
                    ) : tool === 'TUN Mode' ? (
                        <TunSettingsPanel snapshot={snapshot} run={run} />
                    ) : tool === 'Connection' ? (
                        <div className="settings-form">
                            <h3>Proxy Connection</h3>
                            <TunSettingsPanel snapshot={snapshot} run={run} compact />
                            <p>
                                {snapshot.running ? 'Running' : 'Stopped'} at{' '}
                                {snapshot.settings.localhostOnly ? '127.0.0.1' : '0.0.0.0'}:
                                {snapshot.settings.port}
                            </p>
                            <label className="check">
                                <input
                                    type="checkbox"
                                    checked={snapshot.systemProxy}
                                    disabled={busy > 0 || snapshot.settings.captureMode === 'tun'}
                                    onChange={(e) =>
                                        void run(() => window.fluxy.systemProxy(e.target.checked))
                                    }
                                />
                                Use Fluxy as System Proxy
                            </label>
                            <p className="muted">
                                The original HTTP and HTTPS proxy settings are backed up and
                                restored when capture stops. Supports macOS, Windows, and Linux
                                GNOME/KDE desktops.
                            </p>
                            <div className="button-row">
                                <button onClick={() => setTool('Welcome to Fluxy')}>
                                    Setup Guide
                                </button>
                                <button onClick={() => setTool('Certificates')}>
                                    <Shield size={14} />
                                    Certificates
                                </button>
                                <button onClick={() => setTool('Developer Setup')}>
                                    Developer Setup
                                </button>
                                <button onClick={() => setTool('Settings')}>Settings</button>
                                <button onClick={() => setTool('MCP Server')}>MCP Server</button>
                            </div>
                        </div>
                    ) : tool === 'Rename Workspace' ? (
                        <form
                            className="settings-form"
                            onSubmit={(e) => {
                                e.preventDefault()
                                if (!workspaceName.trim()) return
                                patch({ name: workspaceName.trim() })
                                closeTool()
                            }}
                        >
                            <label>
                                Workspace name
                                <input
                                    autoFocus
                                    aria-label="Workspace name"
                                    maxLength={100}
                                    value={workspaceName}
                                    onChange={(e) => setWorkspaceName(e.target.value)}
                                />
                            </label>
                            <button className="primary" disabled={!workspaceName.trim()}>
                                Rename
                            </button>
                        </form>
                    ) : tool === 'Sessions' ? (
                        <div className="settings-form">
                            <p>Choose a saved session to open.</p>
                            {snapshot.sessions.length ? (
                                snapshot.sessions.map((session) => (
                                    <button
                                        key={session.id}
                                        onClick={() => {
                                            setSessionName(session.id)
                                            setTool('Open Session')
                                        }}
                                    >
                                        {session.name} · {session.count} requests
                                    </button>
                                ))
                            ) : (
                                <p className="subtle-empty">
                                    No saved sessions yet. Use File → Save Session to save captured
                                    traffic.
                                </p>
                            )}
                        </div>
                    ) : tool === 'Help' ? (
                        <div className="settings-form">
                            <h3>Inspect traffic with Fluxy</h3>
                            <p>
                                Start Capture, then open Developer Setup to configure your browser,
                                terminal or device to use the proxy. For HTTPS inspection, generate
                                and trust the Fluxy certificate from Certificates.
                            </p>
                            <p>
                                Use File to manage workspaces, save sessions, and import or export
                                HAR files. Select a request to copy its URL or cURL command from
                                Edit, or repeat, pin, save and compare requests from Flow.
                            </p>
                            <p>
                                View controls the sidebar, inspector, context dock, filters and
                                appearance. Proxy controls capture, recording, system proxy and
                                caching. Menu items show their keyboard shortcuts and become
                                available when the required traffic or selection exists.
                            </p>
                            <div className="button-row">
                                <button onClick={() => setTool('Welcome to Fluxy')}>
                                    Setup Guide
                                </button>
                                <button onClick={() => setTool('Developer Setup')}>
                                    Developer Setup
                                </button>
                                <button onClick={() => setTool('Logs')}>Proxy Logs</button>
                            </div>
                        </div>
                    ) : tool === 'Save Session' ? (
                        <div className="settings-form">
                            <label>
                                Session name
                                <input
                                    aria-label="Session name"
                                    value={sessionName}
                                    onChange={(e) => setSessionName(e.target.value)}
                                />
                            </label>
                            <p>{transactions.length} captured requests will be saved locally.</p>
                            <button
                                className="primary"
                                onClick={() =>
                                    void run(async () => {
                                        await window.fluxy.saveSession(sessionName)
                                        setTool(undefined)
                                    }, 'Session saved')
                                }
                            >
                                Save Session
                            </button>
                        </div>
                    ) : tool === 'Open Session' || tool === 'Delete Session' ? (
                        <div className="settings-form">
                            <p>
                                {tool === 'Open Session'
                                    ? 'Replace the current traffic list with this saved session? Save your current session first if needed.'
                                    : 'Delete this saved session from disk?'}
                            </p>
                            <div className="button-row">
                                <button onClick={closeTool}>Cancel</button>
                                <button
                                    className="primary"
                                    onClick={() =>
                                        void run(async () => {
                                            if (tool === 'Open Session')
                                                await window.fluxy.loadSession(sessionName)
                                            else await window.fluxy.deleteSession(sessionName)
                                            patch({ selected: [] })
                                            setTool(undefined)
                                        })
                                    }
                                >
                                    {tool}
                                </button>
                            </div>
                        </div>
                    ) : tool === 'Save Focus Set' ? (
                        <div className="settings-form">
                            <label>
                                Name
                                <input
                                    value={focusName}
                                    onChange={(e) => setFocusName(e.target.value)}
                                />
                            </label>
                            <p>
                                Scope: {workspace.scope} · Filter: {workspace.filter} · Search:{' '}
                                {workspace.query || '(none)'}
                            </p>
                            <button
                                className="primary"
                                disabled={!focusName.trim()}
                                onClick={() => {
                                    setFocusSets([
                                        ...focusSets,
                                        {
                                            name: focusName,
                                            query: workspace.query,
                                            scope: workspace.scope,
                                            filter: workspace.filter
                                        }
                                    ])
                                    setTool(undefined)
                                }}
                            >
                                Save Focus Set
                            </button>
                        </div>
                    ) : tool === 'Logs' ? (
                        <div className="log-list">
                            {snapshot.logs.length ? (
                                snapshot.logs.map((log) => (
                                    <div key={log.id}>
                                        <time>{new Date(log.timestamp).toLocaleTimeString()}</time>
                                        <span
                                            className={
                                                log.level === 'error'
                                                    ? 'red'
                                                    : log.level === 'warn'
                                                      ? 'orange'
                                                      : 'blue'
                                            }
                                        >
                                            {log.level.toUpperCase()}
                                        </span>
                                        <code>{log.message}</code>
                                    </div>
                                ))
                            ) : (
                                <div className="subtle-empty">No proxy events yet.</div>
                            )}
                        </div>
                    ) : tool === 'Compare Requests' ? (
                        <DiffView
                            transactions={transactions}
                            initialIDs={workspace.selected}
                            followUp={diffFollowUp}
                        />
                    ) : null}
                </ToolWindow>
            )}
            {contextMenu && (
                <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
                    {[
                        ['Edit and Resend', editSelected],
                        [
                            'Pin / Unpin',
                            () =>
                                selected &&
                                void run(() =>
                                    window.fluxy.updateTransaction(selected.id, {
                                        pinned: !selected.pinned
                                    })
                                )
                        ],
                        [
                            'Save Request',
                            () =>
                                selected &&
                                void run(() =>
                                    window.fluxy.updateTransaction(selected.id, { saved: true })
                                )
                        ],
                        [
                            'Export Selected HAR',
                            () => void run(() => window.fluxy.exportHAR(workspace.selected))
                        ],
                        [
                            'Mute Domain',
                            () =>
                                selected &&
                                patch({ muted: [...new Set([...workspace.muted, selected.host])] })
                        ],
                        [
                            'Show Details',
                            () => {
                                setDock(true)
                            }
                        ]
                    ].map(([label, action]) => (
                        <button key={label as string} onClick={action as () => void}>
                            {label as string}
                        </button>
                    ))}
                </div>
            )}
            {error && (
                <div className="notification error-notification" role="alert">
                    <TriangleAlert size={18} />
                    <span>{error}</span>
                    <button aria-label="Dismiss error" onClick={() => setError('')}>
                        <X size={15} />
                    </button>
                </div>
            )}
            {toast && (
                <div className="notification toast" role="status">
                    ✓ {toast}
                </div>
            )}
        </div>
    )
}
