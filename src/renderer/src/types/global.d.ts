import type { FluxyAPI } from '@shared/model'
declare global {
    interface Window {
        fluxy: FluxyAPI
    }
}
export {}
