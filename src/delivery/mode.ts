import { getRuntimeSettings } from '../domain/settings'
import type { ExecutionMode, RuntimeSettings } from '../shared/types'

/** Queue message body. `attempt` is the number of attempts already started; the claim compares it. */
export interface DeliveryMessage {
  deliveryId: string
  attempt: number
}

/** Queues cap message delays at 12 hours; later deliveries wait in D1 for the cron. */
export const QUEUE_MAX_DELAY_S = 12 * 60 * 60

/**
 * The only place that reads DELIVERY_QUEUE, typed loosely so the code still
 * compiles after the "queues" section is removed and types are regenerated.
 */
export function deliveryQueue(env: CloudflareBindings): Queue<DeliveryMessage> | null {
  return (env as { DELIVERY_QUEUE?: Queue<DeliveryMessage> }).DELIVERY_QUEUE ?? null
}

export const hasDeliveryQueue = (env: CloudflareBindings) => deliveryQueue(env) !== null

/**
 * - `queue`: deliveries are queue messages (delayed for retries and send_at up
 *   to 12 h); the consumer sends them.
 * - `direct`: due deliveries are sent in the request's waitUntil; scheduled
 *   ones and retries wait in D1 and the per-minute cron sends them.
 * Queue mode without the binding degrades to direct rather than stranding messages.
 */
export async function effectiveMode(env: CloudflareBindings, settings?: RuntimeSettings): Promise<ExecutionMode> {
  const mode = (settings ?? (await getRuntimeSettings(env.DB))).executionMode
  if (mode === 'queue' && !hasDeliveryQueue(env)) {
    console.warn('executionMode is "queue" but DELIVERY_QUEUE is not bound; sending directly')
    return 'direct'
  }
  return mode
}
