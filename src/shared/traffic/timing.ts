import { z } from 'zod'
const duration = z.number().finite().nonnegative().optional()
export const timingSchema = z.object({
    blocked: duration,
    dns: duration,
    connect: duration,
    ssl: duration,
    send: duration,
    wait: duration,
    receive: duration,
    total: duration,
    reusedConnection: z.boolean().optional()
})
export type RequestTiming = z.infer<typeof timingSchema>
export const timingLabels = {
    blocked: 'Preparation / Socket Wait',
    dns: 'DNS Lookup',
    connect: 'TCP Connection',
    ssl: 'TLS Handshake',
    send: 'Request Send',
    wait: 'Time to First Byte',
    receive: 'Content Transfer',
    total: 'Total'
} as const
