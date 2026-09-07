import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const directory = process.argv[2]
if (!directory) {
    process.stderr.write('Fluxy data directory is required.\n')
    process.exit(1)
}
const lines = createInterface({ input: process.stdin })
let queue = Promise.resolve()
lines.on('line', (line) => {
    if (line.length > 1024 * 1024) {
        process.stderr.write('MCP message exceeds 1 MB.\n')
        return
    }
    queue = queue.then(async () => {
        let id: unknown = null
        try {
            const request = JSON.parse(line)
            id = request.id
            const { port, token } = JSON.parse(
                readFileSync(join(directory, 'mcp-handshake.json'), 'utf8')
            )
            const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                    authorization: `Bearer ${token}`
                },
                body: line,
                signal: AbortSignal.timeout(15000)
            })
            if (!response.ok) throw new Error(`MCP server returned ${response.status}`)
            if (response.status !== 202) {
                const text = await response.text()
                if (text) process.stdout.write(text + '\n')
            }
        } catch (error) {
            if (id !== undefined)
                process.stdout.write(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id,
                        error: { code: -32603, message: String(error) }
                    }) + '\n'
                )
        }
    })
})
