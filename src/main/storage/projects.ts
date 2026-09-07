import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import {
    projectCatalogSchema,
    projectActionSchema,
    portableProjectSchema,
    workspaceSchema,
    type ProjectCatalog,
    type Project,
    type ProjectAction
} from '../../shared/workspace/projects'
import type { Store } from './store'

function makeProject(name: string): Project {
    const tab = workspaceSchema.parse({ id: randomUUID(), name: 'All Traffic', isClosable: false })
    return { id: randomUUID(), name, tabs: [tab], activeTabID: tab.id }
}
function makeCatalog(): ProjectCatalog {
    const project = makeProject('Default')
    return { version: 1, activeID: project.id, projects: [project] }
}
export class ProjectStore {
    catalog = makeCatalog()
    error?: string
    initialized = false
    constructor(private store: Store) {
        const file = join(store.directory, 'projects.json')
        if (existsSync(file)) {
            this.initialized = true
            try {
                this.catalog = projectCatalogSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
            } catch {
                this.error =
                    'The project catalog could not be read. Repair Projects preserves a backup before creating a new catalog.'
            }
        }
    }
    private commit(next: ProjectCatalog) {
        const valid = projectCatalogSchema.parse(next)
        this.store.write('projects.json', valid)
        this.catalog = valid
        this.initialized = true
        return valid
    }
    mutate(input: ProjectAction) {
        const action = projectActionSchema.parse(input)
        if (action.kind === 'repair') {
            if (!this.error) return this.catalog
            const file = join(this.store.directory, 'projects.json')
            if (existsSync(file)) copyFileSync(file, `${file}.backup-${Date.now()}`)
            this.commit(makeCatalog())
            this.error = undefined
            return this.catalog
        }
        if (this.error) throw new Error(this.error)
        const next = structuredClone(this.catalog)
        if (action.kind === 'create' || action.kind === 'rename') {
            if (
                next.projects.some(
                    (p) =>
                        p.name.toLocaleLowerCase() === action.name.toLocaleLowerCase() &&
                        (action.kind !== 'rename' || p.id !== action.id)
                )
            )
                throw new Error('A project with this name already exists')
        }
        if (action.kind === 'create') {
            const project = makeProject(action.name)
            next.projects.push(project)
            next.activeID = project.id
        } else {
            const project = next.projects.find((p) => p.id === action.id)
            if (!project) throw new Error('Project no longer exists')
            if (action.kind === 'rename') project.name = action.name
            if (action.kind === 'switch') next.activeID = project.id
            if (action.kind === 'delete') {
                if (next.projects.length === 1)
                    throw new Error('The final project cannot be deleted')
                next.projects = next.projects.filter((p) => p.id !== project.id)
                if (next.activeID === project.id) next.activeID = next.projects[0].id
            }
            if (action.kind === 'tabs') {
                // A delayed save from another project may update its tabs, never the active project.
                project.tabs = action.tabs
                project.activeTabID = action.activeTabID
            }
        }
        return this.commit(next)
    }
    export(id: string) {
        if (this.error) throw new Error(this.error)
        const project = this.catalog.projects.find((p) => p.id === id)
        if (!project) throw new Error('Project no longer exists')
        return portableProjectSchema.parse({
            format: 'fluxy-project',
            version: 1,
            name: project.name,
            activeTabIndex: project.tabs.findIndex((t) => t.id === project.activeTabID),
            tabs: project.tabs.map(({ id: _id, ...tab }) => tab)
        })
    }
    import(input: unknown) {
        if (this.error) throw new Error(this.error)
        const portable = portableProjectSchema.parse(input)
        let name = portable.name,
            suffix = 2
        while (
            this.catalog.projects.some(
                (p) => p.name.toLocaleLowerCase() === name.toLocaleLowerCase()
            )
        )
            name = `${portable.name.slice(0, 90)} (${suffix++})`
        const tabs = portable.tabs.map((t) => ({ ...t, id: randomUUID() }))
        const project = {
            id: randomUUID(),
            name,
            tabs,
            activeTabID: tabs[portable.activeTabIndex].id
        }
        return this.commit({
            ...this.catalog,
            activeID: project.id,
            projects: [...this.catalog.projects, project]
        })
    }
}
