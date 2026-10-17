import { WorkerEntrypoint } from 'cloudflare:workers'
import { sendMessage } from './domain/messages'
import type { SendRequest, SendResult } from './shared/types'

/**
 * Service-binding entrypoint for other Workers (no API key needed):
 *
 *   "services": [{ "binding": "SENDER", "service": "cf-sender", "entrypoint": "SenderRpc" }]
 *   await env.SENDER.send({ topic: 'ops-alert', title: '...', body: '...' })
 *
 * Validation errors reject with a message listing the invalid fields.
 */
export class SenderRpc extends WorkerEntrypoint<CloudflareBindings> {
  async send(input: SendRequest, options: { idempotencyKey?: string } = {}): Promise<SendResult> {
    return sendMessage(this.env, input, {
      source: 'rpc',
      idempotencyKey: options.idempotencyKey ?? null,
      waitUntil: (p) => this.ctx.waitUntil(p),
    })
  }
}
