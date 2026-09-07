import { z } from 'zod'
import { filterRuleSchema } from './filters'

export const workspaceSchema = z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    isClosable: z.boolean().default(true),
    advancedRules: z.array(filterRuleSchema).max(100).default([]),
    advanced: z.boolean().default(false),
    method: z.string().max(30).default('All methods'),
    status: z.string().max(30).default('All statuses'),
    domainFilter: z.string().max(2000).default(''),
    clientFilter: z.string().max(2000).default(''),
    query: z.string().max(10000).default(''),
    filter: z.string().max(100).default('All'),
    scope: z.string().max(2000).default('All Traffic'),
    searchBy: z.enum(['URL', 'Body', 'Headers', 'Method', 'All fields']).default('URL'),
    muted: z.array(z.string().max(2000)).max(1000).default([])
})
export type WorkspaceConfiguration = z.infer<typeof workspaceSchema>
export const projectNameSchema = z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((s) => !/[\x00-\x1f]/.test(s), 'Names cannot contain control characters')
export const projectSchema = z
    .object({
        id: z.string().uuid(),
        name: projectNameSchema,
        activeTabID: z.string().uuid(),
        tabs: z.array(workspaceSchema).min(1).max(100)
    })
    .refine(
        (p) =>
            p.tabs.some((t) => t.id === p.activeTabID) &&
            p.tabs.some((t) => !t.isClosable) &&
            new Set(p.tabs.map((t) => t.id)).size === p.tabs.length,
        'Invalid project tabs'
    )
export type Project = z.infer<typeof projectSchema>
export const projectCatalogSchema = z
    .object({
        version: z.literal(1),
        activeID: z.string().uuid(),
        projects: z.array(projectSchema).min(1).max(100)
    })
    .refine(
        (c) =>
            c.projects.some((p) => p.id === c.activeID) &&
            new Set(c.projects.map((p) => p.id)).size === c.projects.length &&
            new Set(c.projects.map((p) => p.name.toLocaleLowerCase())).size === c.projects.length,
        'Invalid project catalog'
    )
export type ProjectCatalog = z.infer<typeof projectCatalogSchema>
export const projectActionSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('create'), name: projectNameSchema }),
    z.object({ kind: z.literal('rename'), id: z.string().uuid(), name: projectNameSchema }),
    z.object({ kind: z.literal('switch'), id: z.string().uuid() }),
    z.object({ kind: z.literal('delete'), id: z.string().uuid() }),
    z.object({
        kind: z.literal('tabs'),
        id: z.string().uuid(),
        tabs: z.array(workspaceSchema).min(1).max(100),
        activeTabID: z.string().uuid()
    }),
    z.object({ kind: z.literal('repair') })
])
export type ProjectAction = z.infer<typeof projectActionSchema>
export const portableProjectSchema = z
    .object({
        format: z.literal('fluxy-project'),
        version: z.literal(1),
        name: projectNameSchema,
        activeTabIndex: z.number().int().min(0).max(99),
        tabs: z
            .array(workspaceSchema.omit({ id: true }))
            .min(1)
            .max(100)
    })
    .refine(
        (p) => p.activeTabIndex < p.tabs.length && p.tabs.some((t) => !t.isClosable),
        'Invalid project tabs'
    )
