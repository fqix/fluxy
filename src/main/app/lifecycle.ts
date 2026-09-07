interface Stoppable {
    stop(): unknown
}
interface Closable {
    close(): unknown
}
export interface ShutdownServices {
    tun?: Stoppable
    helper?: Closable
    systemProxy?: { enabled: boolean; set(enabled: boolean): unknown }
    engine?: Stoppable
    mcp?: Stoppable
    scripts?: Closable
}

// Startup may have created only a subset of these services. Keep cleanup ordered
// and attempt every step, even when one service cannot shut down normally.
export async function stopServices(services: ShutdownServices): Promise<string[]> {
    const errors: string[] = []
    const steps: [string, () => unknown][] = [
        ['TUN', () => services.tun?.stop()],
        ['Helper', () => services.helper?.close()],
        ['System proxy', () => services.systemProxy?.enabled && services.systemProxy.set(false)],
        ['Capture engine', () => services.engine?.stop()],
        ['MCP', () => services.mcp?.stop()],
        ['Scripts', () => services.scripts?.close()]
    ]
    for (const [name, cleanup] of steps) {
        try {
            await cleanup()
        } catch (error) {
            errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    return errors
}
