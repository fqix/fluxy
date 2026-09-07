import type { ClientRequest } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { performance } from 'node:perf_hooks'
import type { Transaction } from '../../shared/contracts/model'
export function observeTimings(request: ClientRequest, t: Transaction) {
    const started = performance.now() - Math.max(0, Date.now() - t.timestamp)
    let assigned = performance.now(),
        lookup: number | undefined,
        connected: number | undefined,
        ready: number | undefined,
        sent: number | undefined
    const timing = (t.timings = { blocked: assigned - started } as NonNullable<
        Transaction['timings']
    >)
    request.once('socket', (socket) => {
        assigned = performance.now()
        timing.blocked = assigned - started
        if (!socket.connecting) {
            timing.reusedConnection = request.reusedSocket
            ready = assigned
            return
        }
        socket.once('lookup', () => {
            lookup = performance.now()
            timing.dns = lookup - assigned
        })
        socket.once('connect', () => {
            connected = performance.now()
            timing.connect = connected - (lookup ?? assigned)
            if (!(socket as TLSSocket).encrypted) ready = connected
        })
        socket.once('secureConnect', () => {
            ready = performance.now()
            timing.ssl = ready - (connected ?? assigned)
        })
    })
    request.once('finish', () => {
        sent = performance.now()
        timing.send = Math.max(0, sent - (ready ?? assigned))
    })
    request.once('response', (response) => {
        const first = performance.now()
        timing.wait = Math.max(0, first - (sent ?? ready ?? assigned))
        response.once('end', () => {
            timing.receive = performance.now() - first
        })
    })
}
