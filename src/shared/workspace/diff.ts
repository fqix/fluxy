import type { Transaction } from '../contracts/model'
export type DiffTarget = 'Request' | 'Response' | 'Timing'
export interface DiffLine {
    type: 'added' | 'removed' | 'unchanged'
    content: string
    oldLine?: number
    newLine?: number
}
export interface DiffSection {
    title: string
    lines: DiffLine[]
}
export interface DiffResult {
    sections: DiffSection[]
    added: number
    removed: number
}

export interface DiffPair {
    id: string
    name: string
    pinned: boolean
    createdAt: number
    left: Transaction
    right: Transaction
}
export type DiffInput =
    | { left: string; right: string; target: DiffTarget; saved?: string }
    | { textLeft: string; textRight: string }
