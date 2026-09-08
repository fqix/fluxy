import { X509Certificate } from 'node:crypto'
import { access, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserTrust } from './browser-trust'
import { certificateStatus } from './certificates'
import { writePrivateFile } from '../storage/private-files'

export class CertificateTrust {
    browserError?: string
    private pending: Promise<unknown> = Promise.resolve()
    private marker: string
    constructor(
        private directory: string,
        private removeSystem: (der: Buffer) => Promise<void>,
        private browsers = new BrowserTrust(),
        private status = certificateStatus
    ) {
        this.marker = join(directory, 'browser-ca-disabled')
    }

    // Setup, reset, removal and startup cannot race and re-add a revoked root.
    exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.pending.then(operation)
        this.pending = next.catch(() => {})
        return next
    }
    settled() {
        return this.pending
    }

    async sync(explicitSetup = false) {
        if (!explicitSetup) {
            try {
                await access(this.marker)
                return
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
        }
        const directory = join(this.directory, 'certificates')
        const status = await this.status(directory)
        if (status.error) throw new Error(status.error)
        // Never generate or elevate on launch; only propagate an already trusted CA.
        if (!status.generated || !status.trusted) return
        const certificate = new X509Certificate(await readFile(join(directory, 'certs/ca.pem')))
        if (explicitSetup) await rm(this.marker, { force: true })
        try {
            await this.browsers.update(certificate, true)
            this.browserError = undefined
        } catch (error) {
            this.browserError = error instanceof Error ? error.message : String(error)
            throw error
        }
    }

    async remove() {
        // Persist before touching stores: even partial failures must not resurrect trust.
        await writePrivateFile(this.marker, 'disabled\n')
        let certificate: X509Certificate
        try {
            certificate = new X509Certificate(
                await readFile(join(this.directory, 'certificates/certs/ca.pem'))
            )
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            // A missing public certificate with a remaining key is a damaged identity.
            try {
                await access(join(this.directory, 'certificates/keys/ca.private.key'))
            } catch (keyError) {
                if ((keyError as NodeJS.ErrnoException).code === 'ENOENT') return
                throw keyError
            }
            throw new Error('Restore the missing Fluxy root certificate before removing its trust.')
        }
        await this.removeSystem(certificate.raw)
        await this.browsers.update(certificate, false)
    }
}
