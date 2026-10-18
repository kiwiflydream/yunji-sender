import type { ChannelType, Delivery, DeliveryStatus, MessageContent } from '../shared/types'

export const HOUR_MS = 60 * 60_000
export const STATS_BUCKET_MS = 60_000
/** An attempt is considered lost when it holds the lease this long (send timeout is 10 s). */
export const LEASE_MS = 60_000

export interface DeliveryRow {
  id: string
  message_id: string
  channel_id: string
  channel_type: ChannelType
  channel_name: string
  channel_group_slug: string | null
  status: DeliveryStatus
  attempts: number
  next_attempt_at: number
  lease_until: number | null
  duration_ms: number | null
  http_status: number | null
  response_body: string | null
  error: string | null
  finished_at: number | null
  created_at: number
  updated_at: number
}

export const rowToDelivery = (r: DeliveryRow): Delivery => ({
  id: r.id,
  messageId: r.message_id,
  channelId: r.channel_id,
  channelType: r.channel_type,
  channelName: r.channel_name,
  status: r.status,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  durationMs: r.duration_ms,
  httpStatus: r.http_status,
  responseBody: r.response_body,
  error: r.error,
  finishedAt: r.finished_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** A delivery whose attempt `attempts` is in progress. */
export interface ClaimedDelivery {
  id: string
  messageId: string
  channelId: string
  channelType: ChannelType
  channelGroupSlug: string | null
  attempts: number
  content: MessageContent
  sendAt: number
  createdAt: number
}

/**
 * Start attempt `expectedAttempts + 1`. Fails (null) when another attempt got
 * there first, the delivery was canceled or finished, or its message is gone.
 */
export async function claimDelivery(
  db: D1Database,
  id: string,
  expectedAttempts: number,
  now: number,
): Promise<ClaimedDelivery | null> {
  const row = await db
    .prepare(
      `UPDATE deliveries SET status = 'sending', attempts = attempts + 1, lease_until = ?, updated_at = ?
       WHERE id = ? AND attempts = ? AND status IN ('scheduled', 'queued')
       RETURNING id, message_id, channel_id, channel_type, channel_group_slug, attempts`,
    )
    .bind(now + LEASE_MS, now, id, expectedAttempts)
    .first<Pick<DeliveryRow, 'id' | 'message_id' | 'channel_id' | 'channel_type' | 'channel_group_slug' | 'attempts'>>()
  if (!row) return null
  return loadClaimed(db, row)
}

async function loadClaimed(
  db: D1Database,
  row: Pick<DeliveryRow, 'id' | 'message_id' | 'channel_id' | 'channel_type' | 'channel_group_slug' | 'attempts'>,
): Promise<ClaimedDelivery | null> {
  const msg = await db
    .prepare('SELECT payload, send_at, created_at FROM messages WHERE id = ?')
    .bind(row.message_id)
    .first<{ payload: string; send_at: number; created_at: number }>()
  if (!msg) return null
  return {
    id: row.id,
    messageId: row.message_id,
    channelId: row.channel_id,
    channelType: row.channel_type,
    channelGroupSlug: row.channel_group_slug,
    attempts: row.attempts,
    content: JSON.parse(msg.payload),
    sendAt: msg.send_at,
    createdAt: msg.created_at,
  }
}

/** Attempts whose lease expired: the Worker running them died or timed out. */
export async function expiredLeases(db: D1Database, now: number, limit: number): Promise<ClaimedDelivery[]> {
  const { results } = await db
    .prepare(
      `SELECT id, message_id, channel_id, channel_type, channel_group_slug, attempts FROM deliveries
       WHERE status = 'sending' AND lease_until < ? LIMIT ?`,
    )
    .bind(now, limit)
    .all<Pick<DeliveryRow, 'id' | 'message_id' | 'channel_id' | 'channel_type' | 'channel_group_slug' | 'attempts'>>()
  const claimed = await Promise.all(results.map((r) => loadClaimed(db, r)))
  return claimed.filter((c): c is ClaimedDelivery => c !== null)
}

export interface AttemptResult {
  durationMs: number | null
  httpStatus: number | null
  responseBody: string | null
  error: string | null
}

const STATS_UPSERT = `ON CONFLICT (bucket, channel_id, channel_group_slug) DO UPDATE SET
  sent = sent + excluded.sent, failed = failed + excluded.failed, retries = retries + excluded.retries,
  latency_sum = latency_sum + excluded.latency_sum, latency_max = MAX(latency_max, excluded.latency_max)`

/**
 * Count the final outcome of attempt `attempts` of a delivery still `sending`.
 * Batched right before the UPDATE that closes it, so it counts at most once.
 * Bucketed by the message's send_at minute; latency is send_at -> now.
 */
function finalStatsStatement(db: D1Database, id: string, attempts: number, sent: boolean, now: number) {
  return db
    .prepare(
      `INSERT INTO delivery_stats (bucket, channel_id, channel_group_slug, sent, failed, retries, latency_sum, latency_max)
       SELECT m.send_at - m.send_at % ${STATS_BUCKET_MS}, d.channel_id, COALESCE(d.channel_group_slug, ''), ?, ?, d.attempts - 1,
         ? * MAX(0, ? - m.send_at), ? * MAX(0, ? - m.send_at)
       FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE d.id = ? AND d.status = 'sending' AND d.attempts = ?
       ${STATS_UPSERT}`,
    )
    .bind(sent ? 1 : 0, sent ? 0 : 1, sent ? 1 : 0, now, sent ? 1 : 0, now, id, attempts)
}

/** Close attempt `attempts` as sent or failed. Returns false if it no longer owned the delivery. */
export async function finishDelivery(
  db: D1Database,
  d: Pick<ClaimedDelivery, 'id' | 'attempts'>,
  status: 'sent' | 'failed',
  result: AttemptResult,
  now: number,
): Promise<boolean> {
  const [, update] = await db.batch([
    finalStatsStatement(db, d.id, d.attempts, status === 'sent', now),
    db
      .prepare(
        `UPDATE deliveries SET status = ?, lease_until = NULL, duration_ms = ?, http_status = ?, response_body = ?,
           error = ?, finished_at = ?, updated_at = ?
         WHERE id = ? AND status = 'sending' AND attempts = ?`,
      )
      .bind(status, result.durationMs, result.httpStatus, result.responseBody, result.error, now, now, d.id, d.attempts),
  ])
  return update.meta.changes > 0
}

/** Close attempt `attempts` as failed and wait for another one at `nextAt`. */
export async function deferDelivery(
  db: D1Database,
  d: Pick<ClaimedDelivery, 'id' | 'attempts'>,
  status: 'queued' | 'scheduled',
  nextAt: number,
  result: AttemptResult,
  now: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE deliveries SET status = ?, next_attempt_at = ?, lease_until = NULL, duration_ms = ?, http_status = ?,
         response_body = ?, error = ?, updated_at = ?
       WHERE id = ? AND status = 'sending' AND attempts = ?`,
    )
    .bind(status, nextAt, result.durationMs, result.httpStatus, result.responseBody, result.error, now, d.id, d.attempts)
    .run()
  return res.meta.changes > 0
}

/** Fall back to the cron after a queue send failed. */
export async function markScheduled(db: D1Database, ids: string[], now: number): Promise<void> {
  if (ids.length === 0) return
  // Reserve one of D1's 100 bind parameters for the timestamp.
  for (let i = 0; i < ids.length; i += 99) {
    const chunk = ids.slice(i, i + 99)
    await db.prepare(`UPDATE deliveries SET status = 'scheduled', updated_at = ?
      WHERE id IN (${chunk.map(() => '?').join(',')}) AND status = 'queued'`).bind(now, ...chunk).run()
  }
}

export async function deliveriesOf(db: D1Database, messageId: string): Promise<Delivery[]> {
  const { results } = await db
    .prepare('SELECT * FROM deliveries WHERE message_id = ? ORDER BY created_at, channel_name')
    .bind(messageId)
    .all<DeliveryRow>()
  return results.map(rowToDelivery)
}

/**
 * Re-open a failed or canceled delivery for one more attempt now. A failure
 * that was already counted in the statistics is taken back out, so the new
 * outcome replaces it.
 */
export async function reopenDelivery(
  db: D1Database,
  id: string,
  status: 'queued' | 'scheduled',
  now: number,
): Promise<{ attempts: number } | null> {
  const [, update] = await db.batch([
    db
      .prepare(
        `UPDATE delivery_stats SET failed = failed - 1, retries = MAX(0, retries - (
           SELECT attempts - 1 FROM deliveries WHERE id = ?1))
         WHERE (bucket, channel_id, channel_group_slug) = (
           SELECT m.send_at - m.send_at % ${STATS_BUCKET_MS}, d.channel_id, COALESCE(d.channel_group_slug, '')
           FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.id = ?1 AND d.status = 'failed')
         AND failed > 0`,
      )
      .bind(id),
    db
      .prepare(
        `UPDATE deliveries SET status = ?, next_attempt_at = ?, finished_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('failed', 'canceled') RETURNING attempts`,
      )
      .bind(status, now, now, id),
  ])
  const row = (update.results as { attempts: number }[])[0]
  return row ?? null
}
