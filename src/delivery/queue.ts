import { deliveryQueue, QUEUE_MAX_DELAY_S } from './mode'
import { MAX_DISPATCHES } from './limits'
import { markScheduled } from './repo'
import { parkDeliveries, safetyCode } from '../domain/safety'
import { withTimeout } from '../lib/timeout'

export interface Dispatchable {
  id: string
  attempts: number
  nextAttemptAt: number
}

/** Persist a bounded dispatch reservation before every enqueue, including retries. */
export async function enqueueDeliveries(env: CloudflareBindings, items: Dispatchable[], now: number): Promise<void> {
  for (let i = 0; i < items.length; i += 100) {
    const chunk = items.slice(i, i + 100)
    let results: { id: string; attempts: number; next_attempt_at: number }[]
    try {
      ({ results } = await env.DB.prepare(`UPDATE deliveries SET
        dispatch_count = dispatch_count + 1, last_dispatched_at = ?1,
        dispatch_after = ?1 + MIN(3600000, 60000 * (1 << MIN(dispatch_count, 6))), updated_at = ?1
      WHERE (id, attempts) IN (SELECT json_extract(value, '$.id'), json_extract(value, '$.attempts') FROM json_each(?2))
        AND status = 'queued' AND dispatch_after <= ?1 AND dispatch_count < ${MAX_DISPATCHES}
        AND deadline_at > ?1
      RETURNING id, attempts, next_attempt_at`).bind(now, JSON.stringify(chunk))
      .all<{ id: string; attempts: number; next_attempt_at: number }>())
    } catch (err) {
      const code = safetyCode(err)
      if (!code) throw err
      await parkDeliveries(env.DB, chunk, code, now)
      continue
    }
    if (!results.length) continue
    try {
      await withTimeout(deliveryQueue(env)!.sendBatch(results.map((d) => ({
        body: { deliveryId: d.id, attempt: d.attempts },
        delaySeconds: Math.min(Math.max(0, Math.ceil((d.next_attempt_at - now) / 1000)), QUEUE_MAX_DELAY_S),
      }))), 10_000)
    } catch (err) {
      // A timeout has an unknown enqueue outcome. Keep the reservation and backoff;
      // late/duplicate queue messages still share the same delivery claim fence.
      console.error('failed to enqueue deliveries; bounded cron recovery will retry', err)
      await markScheduled(env.DB, results.map((d) => d.id), now)
    }
  }
}
