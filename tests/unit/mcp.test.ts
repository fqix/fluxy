import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'
import { once } from 'node:events'
import { Store } from '../../src/main/store'
import { ProxyEngine } from '../../src/main/proxy'
import { MCPService } from '../../src/main/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
let directory: string, store: Store, engine: ProxyEngine, service: MCPService
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fluxy-mcp-'))
    store = new Store(directory)
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1')
    await once(probe, 'listening')
    store.settings.mcpPort = (probe.address() as net.AddressInfo).port
    await new Promise<void>((r) => probe.close(() => r()))
    engine = new ProxyEngine(store, () => {})
    service = new MCPService(store, engine)
    await service.start()
})
afterEach(async () => {
    await service.stop()
    await rm(directory, { recursive: true, force: true })
})
it('rejects unauthenticated requests and browser origins', async () => {
    const url = `http://127.0.0.1:${store.settings.mcpPort}/mcp`
    expect((await fetch(url, { method: 'POST' })).status).toBe(401)
    expect(
        (
            await fetch(url, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${service.token}`,
                    origin: 'https://attacker.example'
                }
            })
        ).status
    ).toBe(403)
})
it('works with the official MCP client and exposes all ten read-only tools', async () => {
    const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${store.settings.mcpPort}/mcp`),
        { requestInit: { headers: { Authorization: `Bearer ${service.token}` } } }
    )
    const client = new Client({ name: 'fluxy-regression', version: '1.0.0' })
    try {
        await client.connect(transport)
        const tools = await client.listTools()
        expect(tools.tools).toHaveLength(10)
        expect(tools.tools.every((t) => t.annotations?.readOnlyHint)).toBe(true)
        const t = engine.create('https://example.com/api?token=SECRET_QUERY', 'POST', {
            authorization: 'Bearer SECRET_HEADER'
        })
        t.requestBody = JSON.stringify({ password: 'SECRET_BODY', safe: 'hello' })
        engine.complete(t)
        const result = await client.callTool({
            name: 'get_flow_detail',
            arguments: { flow_id: t.id }
        })
        const text = JSON.stringify(result)
        expect(text).not.toContain('SECRET_QUERY')
        expect(text).not.toContain('SECRET_HEADER')
        expect(text).not.toContain('SECRET_BODY')
        expect(text).toContain('hello')
        const flows = await client.callTool({
            name: 'get_recent_flows',
            arguments: { filter_method: 'POST' }
        })
        expect(JSON.stringify(flows)).toContain(t.id)
        const curl = await client.callTool({
            name: 'export_flow_curl',
            arguments: { flow_id: t.id }
        })
        expect(JSON.stringify(curl)).toContain('curl')
        expect(JSON.stringify(curl)).not.toContain('SECRET_')
    } finally {
        await client.close()
    }
})
