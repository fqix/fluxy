import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

test('imports real HAR, displays WebSocket frames, filters gRPC errors and decodes streamed protobuf', async ({}, testInfo) => {
    test.setTimeout(90000)
    const file = resolve(process.env.FLUXY_HAR_FIXTURE || 'tests/fixtures/har/real-protocols.har')
    const har = JSON.parse(await readFile(file, 'utf8'))
    const directory = await mkdtemp(join(tmpdir(), 'fluxy-har-e2e-'))
    const app = await electron.launch({
        args: ['.'],
        env: { ...process.env, FLUXY_DATA_DIR: directory }
    })
    try {
        const page = await app.firstWindow()
        const errors: string[] = []
        page.on('pageerror', (e) => errors.push(e.message))
        await page
            .getByRole('dialog', { name: 'Welcome to Fluxy' })
            .getByRole('button', { name: 'Close', exact: true })
            .click()
        await app.evaluate(({ dialog }, file) => {
            dialog.showOpenDialog = (async () => ({
                canceled: false,
                filePaths: [file]
            })) as typeof dialog.showOpenDialog
            dialog.showMessageBox = (async () => ({
                response: 0,
                checkboxChecked: false
            })) as typeof dialog.showMessageBox
        }, file)
        await page.evaluate(() => window.fluxy.importHAR())
        await expect
            .poll(
                async () => (await page.evaluate(() => window.fluxy.snapshot())).transactions.length
            )
            .toBe(har.log.entries.length)
        const filter = (name: string) =>
            page.locator('.filter-tabs').getByRole('button', { name, exact: true })
        await filter('WebSocket').click()
        await expect(page.locator('tr[data-request-id]')).toHaveCount(1)
        await page.locator('tr[data-request-id]').click()
        const response = page.locator('.inspector-pane').nth(1)
        await response.getByRole('button', { name: 'Frames', exact: true }).click()
        await expect(response.locator('.frames > div')).toHaveCount(2)
        await expect(response).toContainText('Fluxy real WebSocket capture test')
        await filter('gRPC').click()
        const grpcCount = har.log.entries.filter(
            (e: { response: { content: { mimeType: string } } }) =>
                e.response.content.mimeType.startsWith('application/grpc')
        ).length
        await expect(page.locator('tr[data-request-id]')).toHaveCount(grpcCount)
        await page
            .locator('tr[data-request-id]')
            .filter({ hasText: '/SpecificError' })
            .first()
            .click()
        await response.getByRole('button', { name: 'gRPC', exact: true }).click()
        await expect(response).toContainText('Permission denied test')
        await filter('RPC Error').click()
        await expect(
            page.locator('tr[data-request-id]').filter({ hasText: 'grpcb.in' })
        ).toHaveCount(3)
        const source = await readFile('tests/fixtures/har/grpcbin.proto', 'utf8')
        await page.evaluate(
            async ({ source, id }) => {
                const state = await window.fluxy.snapshot()
                await window.fluxy.settings({
                    ...state.settings,
                    protobufSchemas: [{ id, name: 'grpcbin.proto', source }],
                    protobufType: 'grpcbin.DummyMessage'
                })
            },
            { source, id: randomUUID() }
        )
        await filter('gRPC').click()
        await page.locator('tr[data-request-id]').filter({ hasText: '/DummyUnary' }).click()
        await response.getByRole('button', { name: 'Protobuf', exact: true }).click()
        await expect(response).toContainText('真实 gRPC 测试')
        await page.locator('tr[data-request-id]').filter({ hasText: '/DummyServerStream' }).click()
        await response.getByRole('button', { name: 'Protobuf', exact: true }).click()
        await expect
            .poll(async () => {
                try {
                    return JSON.parse(await response.locator('.pane-body > pre').innerText()).length
                } catch {
                    return 0
                }
            })
            .toBe(10)
        await page.screenshot({ path: testInfo.outputPath('har-grpc-stream.png') })
        expect(errors).toEqual([])
    } finally {
        await app.close()
        await rm(directory, { recursive: true, force: true })
    }
})
