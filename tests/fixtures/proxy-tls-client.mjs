import http from 'node:http'
import tls from 'node:tls'
import { readFileSync } from 'node:fs'

// Use Node's TLS implementation on every platform, retaining CA verification and
// a separate process for the proxy's connection-owner lookup.
const [proxyPort, targetPort, caPath] = process.argv.slice(2)
const timeout = setTimeout(() => {
    console.error('TLS proxy client timed out')
    process.exit(1)
}, 15000)
try {
    const socket = await new Promise((resolve, reject) => {
        const request = http.request({
            hostname: '127.0.0.1',
            port: Number(proxyPort),
            method: 'CONNECT',
            path: `localhost:${targetPort}`
        })
        request.on('error', reject)
        request.on('connect', (response, socket, head) => {
            if (response.statusCode !== 200) {
                socket.destroy()
                reject(new Error(`CONNECT returned ${response.statusCode}`))
                return
            }
            if (head.length) socket.unshift(head)
            resolve(socket)
        })
        request.end()
    })
    const secure = tls.connect({ socket, servername: 'localhost', ca: readFileSync(caPath) })
    const response = await new Promise((resolve, reject) => {
        const chunks = []
        secure.on('error', reject)
        secure.on('data', (chunk) => chunks.push(chunk))
        secure.on('end', () => resolve(Buffer.concat(chunks).toString()))
        secure.on('secureConnect', () => {
            secure.write(
                `GET /tls-breakpoint HTTP/1.1\r\nHost: localhost:${targetPort}\r\nConnection: close\r\n\r\n`
            )
        })
    })
    if (!response.startsWith('HTTP/1.1 200')) throw new Error(`Unexpected response: ${response}`)
    process.stdout.write(response)
} catch (error) {
    console.error(error)
    process.exitCode = 1
} finally {
    clearTimeout(timeout)
}
