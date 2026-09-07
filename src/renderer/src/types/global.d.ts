import type { FluxyAPI } from '@shared/contracts/model'
declare global {
    interface Window {
        fluxy: FluxyAPI
    }
}
export {}
