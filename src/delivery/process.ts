import { loadChannel } from '../domain/channels'
import { getRuntimeSettings } from '../domain/settings'
import { getProvider } from '../channels/registry'
import type { OutboundMessage, SendOutcome } from '../channels/types'
import { redact } from '../lib/redact'
import type { RuntimeSettings } from '../shared/types'
import { deliveryQueue, effectiveMode, QUEUE_MAX_DELAY_S, type DeliveryMessage } from './mode'
import { claimDelivery, deferDelivery, finishDelivery, markScheduled, type ClaimedDelivery } from './repo'

/** Delay before attempt n+1 after n failed attempts (the last value repeats). */
export const BACKOFF_SECONDS = [10, 30, 120, 600, 1800, 3600]
export const MAX_RETRY_AFTER_MS = 60 * 60_000

export function retryDelayMs(failedAttempts: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.min(Math.max(retryAfterMs, 1000), MAX_RETRY_AFTER_MS)
  return BACKOFF_SECONDS[Math.min(failedAttempts, BACKOFF_SECONDS.length) - 1] * 1000
}

export type WaitUntil = (promise: Promise<unknown>) => void

const failure = (error: string, retryable = false): SendOutcome => ({
  ok: false,
  retryable,
  retryAfterMs: null,
  httpStatus: null,
  responseBody: null,
  error,
  durationMs: 0,
})

/** Run the provider for a claimed delivery. Never throws; secrets are redacted from the result. */
export async function attemptDelivery(env: CloudflareBindings, d: ClaimedDelivery): Promise<SendOutcome> {
  const channel = await loadChannel(env, d.channelId)
  if (!channel) return failure('渠道已删除')
  if (!channel.enabled) return failure('渠道已停用')
  const msg: OutboundMessage = {
    ...d.content,
    raw: d.content.raw?.[channel.type] ?? null,
    deliveryId: d.id,
    messageId: d.messageId,
    topic: d.topicSlug,
    createdAt: d.createdAt,
  }
  let outcome: SendOutcome
  try {
    outcome = await getProvider(channel.type).send(channel.config, msg)
  } catch (err) {
    outcome = failure(err instanceof Error ? err.message : String(err))
  }
  return {
    ...outcome,
    responseBody: outcome.responseBody === null ? null : redact(outcome.responseBody, channel.secretValues),
    ...(outcome.ok ? {} : { error: redact(outcome.error, channel.secretValues) }),
  }
}

/** Record an attempt's outcome: sent, retry later, or failed for good. */
export async function settleAttempt(
  env: CloudflareBindings,
  d: ClaimedDelivery,
  outcome: SendOutcome,
  settings: RuntimeSettings,
  now = Date.now(),
): Promise<void> {
  const result = {
    durationMs: outcome.durationMs,
    httpStatus: outcome.httpStatus,
    responseBody: outcome.responseBody,
    error: outcome.ok ? null : outcome.error,
  }
  if (outcome.ok) {
    await finishDelivery(env.DB, d, 'sent', result, now)
    return
  }
  if (!outcome.retryable || d.attempts >= settings.maxAttempts) {
    await finishDelivery(env.DB, d, 'failed', result, now)
    return
  }
  const delayMs = retryDelayMs(d.attempts, outcome.retryAfterMs)
  const mode = await effectiveMode(env, settings)
  // Direct mode has no delayed execution: the cron picks the retry up when due.
  const status = mode === 'queue' ? 'queued' : 'scheduled'
  if (!(await deferDelivery(env.DB, d, status, now + delayMs, result, now))) return
  if (status === 'queued') {
    try {
      await deliveryQueue(env)!.send(
        { deliveryId: d.id, attempt: d.attempts },
        { delaySeconds: Math.min(Math.ceil(delayMs / 1000), QUEUE_MAX_DELAY_S) },
      )
    } catch (err) {
      console.error('failed to enqueue retry; leaving it to the cron', d.id, err)
      await markScheduled(env.DB, [d.id], Date.now())
    }
  }
}

/** One attempt of one delivery. Throws only on infrastructure (D1) errors. */
export async function processDelivery(env: CloudflareBindings, msg: DeliveryMessage, now = Date.now()): Promise<void> {
  const claimed = await claimDelivery(env.DB, msg.deliveryId, msg.attempt, now)
  if (!claimed) return
  const outcome = await attemptDelivery(env, claimed)
  await settleAttempt(env, claimed, outcome, await getRuntimeSettings(env.DB))
}

export async function handleDeliveryBatch(batch: MessageBatch<DeliveryMessage>, env: CloudflareBindings): Promise<void> {
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        await processDelivery(env, message.body)
        message.ack()
      } catch (err) {
        console.error('delivery processing failed', message.body.deliveryId, err)
        message.retry({ delaySeconds: 10 })
      }
    }),
  )
}
