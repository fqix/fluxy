import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

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
    renderer: { plugins: [react()] }
})
