import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
        build: {
            rollupOptions: {
                input: {
                    index: 'src/main/index.ts',
                    watchdog: 'src/main/watchdog.ts',
                    'mcp-bridge': 'src/main/mcp-bridge.ts'
                }
            }
        }
    },
    preload: { plugins: [externalizeDepsPlugin()] },
    renderer: {
        resolve: {
            alias: {
                '@': resolve('src/renderer/src'),
                '@shared': resolve('src/shared'),
                '@assets': resolve('resources')
            }
        },
        plugins: [react(), tailwindcss()]
    }
})
