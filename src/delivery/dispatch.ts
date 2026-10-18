import type { ExecutionMode } from '../shared/types'
import { processDelivery, type WaitUntil } from './process'
import { markScheduled } from './repo'
import { DIRECT_BATCH_LIMIT } from './limits'
import { enqueueDeliveries, type Dispatchable } from './queue'

export type { Dispatchable } from './queue'

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
  await enqueueDeliveries(env, items, now)
}
