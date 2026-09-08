import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
export default defineConfig({
    resolve: {
        alias: {
            '@': resolve('src/renderer/src'),
            '@shared': resolve('src/shared'),
            '@assets': resolve('resources')
        }
    },
    test: {
        include: ['tests/unit/**/*.test.ts'],
        testTimeout: process.platform === 'win32' ? 60000 : 20000
    }
})
