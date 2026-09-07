import React from 'react'
import { createRoot } from 'react-dom/client'
import type { FluxyAPI } from '../../shared/model'
import { App } from './App'
import './styles.css'
declare global {
    interface Window {
        fluxy: FluxyAPI
    }
}
createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
)
