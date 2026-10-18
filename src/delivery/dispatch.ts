import type { ExecutionMode } from '../shared/types'
import { deliveryQueue, QUEUE_MAX_DELAY_S } from './mode'
import { processDelivery, type WaitUntil } from './process'
import { markScheduled } from './repo'
import { DIRECT_BATCH_LIMIT } from './limits'

export interface Dispatchable {
  id: string
  /** Attempts already started (the claim's expected value). */
  attempts: number
  nextAttemptAt: number
}

const SEND_BATCH = 100

/**
 * Hand deliveries that are already `queued` in D1 to the executor. Queue mode
 * enqueues them (delayed until due); direct mode sends them in `waitUntil` and
 * expects them to be due. If enqueueing fails they fall back to `scheduled`
 * for the cron.
 */
export async function dispatchQueued(
  env: CloudflareBindings,
  mode: ExecutionMode,
  items: Dispatchable[],
  waitUntil: WaitUntil,
  now = Date.now(),
): Promise<void> {
  if (items.length === 0) return
  if (mode === 'direct') {
    // Overflow has not been attempted: the next cron may claim it without spending a retry.
    await markScheduled(env.DB, items.slice(DIRECT_BATCH_LIMIT).map((d) => d.id), now)
    waitUntil(
      Promise.all(
        items.slice(0, DIRECT_BATCH_LIMIT).map((d) =>
          processDelivery(env, { deliveryId: d.id, attempt: d.attempts }).catch((err) =>
            console.error('direct delivery failed', d.id, err),
          ),
        ),
      ),
    )
    return
  }
  const queue = deliveryQueue(env)!
  for (let i = 0; i < items.length; i += SEND_BATCH) {
    const chunk = items.slice(i, i + SEND_BATCH)
    try {
      await queue.sendBatch(
        chunk.map((d) => ({
          body: { deliveryId: d.id, attempt: d.attempts },
          delaySeconds: Math.min(Math.max(0, Math.ceil((d.nextAttemptAt - now) / 1000)), QUEUE_MAX_DELAY_S),
        })),
      )
    } catch (err) {
      console.error('failed to enqueue deliveries; leaving them to the cron', err)
      await markScheduled(env.DB, chunk.map((d) => d.id), Date.now())
    }
  }
}
