export interface UpdateState {
    phase:
        | 'idle'
        | 'unsupported'
        | 'checking'
        | 'available'
        | 'current'
        | 'downloading'
        | 'downloaded'
        | 'installing'
        | 'error'
    currentVersion: string
    version?: string
    notes?: string
    percent?: number
    transferred?: number
    total?: number
    checkedAt?: number
    error?: string
}
export type UpdateAction = 'check' | 'download' | 'cancel' | 'install'
