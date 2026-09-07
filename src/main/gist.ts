import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { toHAR } from '../shared/har'
import { redactTransaction } from '../shared/redaction'
import type { Transaction } from '../shared/model'

export class GistService {
    private reviews = new Map<string, { content: string; expires: number }>()
    constructor(private request: typeof fetch = fetch) {}
    review(items: Transaction[]) {
        if (!items.length) throw new Error('Select requests to publish')
        const content = JSON.stringify(toHAR(items.map(redactTransaction)), null, 2)
        if (Buffer.byteLength(content) > 1024 * 1024)
            throw new Error('Select fewer requests; the reviewed archive exceeds 1 MB')
        const id = randomUUID()
        for (const [key, value] of this.reviews)
            if (value.expires < Date.now()) this.reviews.delete(key)
        if (this.reviews.size >= 5) this.reviews.delete(this.reviews.keys().next().value!)
        this.reviews.set(id, { content, expires: Date.now() + 5 * 60 * 1000 })
        return { id, content }
    }
    async publish(input: {
        reviewID: string
        token: string
        description: string
        public: boolean
    }) {
        const value = z
            .object({
                reviewID: z.string().uuid(),
                token: z
                    .string()
                    .trim()
                    .min(1)
                    .max(500)
                    .regex(/^[A-Za-z0-9_]+$/),
                description: z.string().max(500),
                public: z.boolean()
            })
            .parse(input)
        const review = this.reviews.get(value.reviewID)
        if (!review || review.expires < Date.now())
            throw new Error('Review expired. Preview the selected requests again.')
        // Consume before sending so retries after an uncertain response cannot publish twice.
        this.reviews.delete(value.reviewID)
        const response = await this.request('https://api.github.com/gists', {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(30000),
            headers: {
                Authorization: `Bearer ${value.token}`,
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json',
                'X-GitHub-Api-Version': '2026-03-10'
            },
            body: JSON.stringify({
                description: value.description,
                public: value.public,
                files: { 'fluxy.har': { content: review.content } }
            })
        })
        if (response.status !== 201)
            throw new Error(
                `GitHub rejected publishing (HTTP ${response.status}). Check the token's Gists write permission.`
            )
        const result = z
            .object({
                html_url: z
                    .string()
                    .url()
                    .refine((url) => new URL(url).origin === 'https://gist.github.com')
            })
            .parse(await response.json())
        return result.html_url
    }
}
