import { supportedHelperPlatform } from '../system/helper-platform'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, X509Certificate } from 'node:crypto'
import forge from 'node-forge'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CertificateStatus } from '../../shared/contracts/model'

const generating = new Map<string, Promise<string>>()
export function ensureCertificate(directory: string): Promise<string> {
    const pending = generating.get(directory)
    if (pending) return pending
    const result = createCertificate(directory).finally(() => generating.delete(directory))
    generating.set(directory, result)
    return result
}
async function createCertificate(directory: string): Promise<string> {
    const certs = join(directory, 'certs'),
        keys = join(directory, 'keys')
    mkdirSync(certs, { recursive: true, mode: 0o700 })
    mkdirSync(keys, { recursive: true, mode: 0o700 })
    const path = join(certs, 'ca.pem')
    if (existsSync(path)) {
        validateCertificate(directory)
        return path
    }
    // Never replace a partial identity silently: a trusted old root may still be installed.
    if (existsSync(join(keys, 'ca.private.key')))
        throw new Error(
            'Root certificate is missing, but its key exists. Restore the certificate backup first.'
        )
    const pair = await new Promise<forge.pki.rsa.KeyPair>((resolve, reject) =>
        forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (error, keys) =>
            error ? reject(error) : resolve(keys)
        )
    )
    const cert = forge.pki.createCertificate()
    cert.publicKey = pair.publicKey
    cert.serialNumber = '01' + randomBytes(16).toString('hex')
    cert.validity.notBefore = new Date(Date.now() - 86400000)
    cert.validity.notAfter = new Date(Date.now() + 3650 * 86400000)
    const attrs = [
        { name: 'commonName', value: 'Fluxy Electron Root CA' },
        { name: 'organizationName', value: 'Fluxy' }
    ]
    cert.setSubject(attrs)
    cert.setIssuer(attrs)
    cert.setExtensions([
        { name: 'basicConstraints', cA: true, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
        { name: 'subjectKeyIdentifier' }
    ])
    cert.sign(pair.privateKey, forge.md.sha256.create())
    writeFileSync(join(keys, 'ca.private.key'), forge.pki.privateKeyToPem(pair.privateKey), {
        mode: 0o600
    })
    writeFileSync(join(keys, 'ca.public.key'), forge.pki.publicKeyToPem(pair.publicKey), {
        mode: 0o600
    })
    writeFileSync(path, forge.pki.certificateToPem(cert), { mode: 0o600 })
    return path
}

function validateCertificate(directory: string) {
    const certificate = forge.pki.certificateFromPem(
        readFileSync(join(directory, 'certs', 'ca.pem'), 'utf8')
    )
    const key = forge.pki.privateKeyFromPem(
        readFileSync(join(directory, 'keys', 'ca.private.key'), 'utf8')
    ) as forge.pki.rsa.PrivateKey
    if (!(certificate.publicKey as forge.pki.rsa.PublicKey).n.equals(key.n))
        throw new Error('Root certificate and private key do not match.')
    if (certificate.validity.notAfter < new Date())
        throw new Error(
            'The Fluxy Electron root certificate has expired. Export sessions and renew the certificate before HTTPS inspection.'
        )
}

// Read-only: opening setup must never create an identity or change the trust store.
export async function certificateStatus(
    directory: string,
    customPath?: string
): Promise<CertificateStatus> {
    const status: CertificateStatus = {
        generated: false,
        trusted: false,
        supported: supportedHelperPlatform()
    }
    const path = customPath ?? join(directory, 'certs', 'ca.pem')
    try {
        if (!existsSync(path)) {
            if (existsSync(join(directory, 'keys', 'ca.private.key')))
                throw new Error(
                    'Root certificate is missing, but its key exists. Restore the certificate backup first.'
                )
            return status
        }
        if (customPath) {
            const cert = new X509Certificate(readFileSync(path))
            if (!cert.ca || !cert.verify(cert.publicKey) || Date.parse(cert.validTo) <= Date.now())
                throw new Error('Custom root certificate is invalid or expired')
        } else validateCertificate(directory)
        status.generated = true
        if (!status.supported) return status
        try {
            // Use the actual keychain trust evaluation, never supply this CA as a trust anchor.
            if (process.platform === 'darwin') {
                await promisify(execFile)(
                    '/usr/bin/security',
                    ['verify-cert', '-c', path, '-p', 'basic', '-l', '-L'],
                    { timeout: 10000 }
                )
                status.trusted = true
            } else if (process.platform === 'linux') {
                // OpenSSL uses the system CA bundle, never this file as a trust anchor.
                await promisify(execFile)('openssl', ['verify', path], { timeout: 10000 })
                status.trusted = true
            } else if (process.platform === 'win32') {
                const fingerprint = new X509Certificate(readFileSync(path)).fingerprint256.replace(
                    /:/g,
                    ''
                )
                const { stdout } = await promisify(execFile)(
                    'powershell.exe',
                    [
                        '-NoProfile',
                        '-NonInteractive',
                        '-Command',
                        `$ErrorActionPreference='Stop'; $store=New-Object System.Security.Cryptography.X509Certificates.X509Store('Root','LocalMachine'); $store.Open('ReadOnly'); try { $sha=[Security.Cryptography.SHA256]::Create(); $found=@($store.Certificates | Where-Object { [BitConverter]::ToString($sha.ComputeHash($_.RawData)).Replace('-','') -eq '${fingerprint}' }).Count -gt 0; $found | ConvertTo-Json } finally { $store.Close() }`
                    ],
                    { timeout: 30000, windowsHide: true }
                )
                status.trusted = JSON.parse(stdout) === true
            }
        } catch (error) {
            const failure = error as { stdout?: string; stderr?: string }
            const output = `${failure.stdout ?? ''} ${failure.stderr ?? ''}`
            if (
                !/not trusted|not_trusted|invalid root|invalid_root|self.signed certificate|unable to get local issuer/i.test(
                    output
                )
            )
                status.error =
                    'Certificate trust could not be checked. Recheck Status before installing or trusting it.'
        }
    } catch (error) {
        status.error = String(error).replace(/^Error: /, '')
    }
    return status
}
