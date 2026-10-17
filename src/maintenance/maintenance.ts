import { dispatchQueued } from '../delivery/dispatch'
import { effectiveMode, QUEUE_MAX_DELAY_S } from '../delivery/mode'
import { processDelivery, settleAttempt, type WaitUntil } from '../delivery/process'
import { expiredLeases } from '../delivery/repo'
import { getRuntimeSettings } from '../domain/settings'

/** Rows handled per cron run and step; a backlog drains over several minutes. */
export const SCAN_LIMIT = 500
/** A `queued` delivery this far past due was lost (queue send failed, message dead-lettered, waitUntil cut short). */
export const STALE_QUEUED_MS = 15 * 60_000
const DIRECT_CONCURRENCY = 6
export const DAY_MS = 24 * 60 * 60_000
const PURGE_INTERVAL_MS = 60 * 60_000
const PURGE_KEY = 'maintenance:purge'
const PURGE_BATCH = 500
const MAX_PURGE_BATCHES = 20

export interface MaintenanceReport {
  dispatched: number
  revived: number
  expiredLeases: number
  purgedMessages: number
  purgedStats: number
}

/**
 * Every minute:
 * 1. dispatch `scheduled` deliveries that are due (queue mode: due within the
 *    queue's 12 h delay limit, enqueued with the remaining delay);
 * 2. return lost `queued` deliveries to `scheduled` (picked up next run);
 * 3. settle attempts whose lease expired as a retryable failure;
 * 4. hourly, purge messages and statistics past their retention.
 */
export async function runMaintenance(
  env: CloudflareBindings,
  waitUntil: WaitUntil,
  now = Date.now(),
): Promise<MaintenanceReport> {
  const settings = await getRuntimeSettings(env.DB)
  const mode = await effectiveMode(env, settings)

  const horizon = mode === 'queue' ? now + (QUEUE_MAX_DELAY_S - 60) * 1000 : now
  const { results: due } = await env.DB
    .prepare(
      `SELECT id, attempts, next_attempt_at FROM deliveries WHERE status = 'scheduled' AND next_attempt_at <= ?
       ORDER BY next_attempt_at LIMIT ?`,
    )
    .bind(horizon, SCAN_LIMIT)
    .all<{ id: string; attempts: number; next_attempt_at: number }>()
  let dispatched = 0
  if (mode === 'queue') {
    const claimed = due.length === 0 ? [] : await env.DB.batch(
      due.map((d) =>
        env.DB
          .prepare(`UPDATE deliveries SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'scheduled' AND attempts = ?`)
          .bind(now, d.id, d.attempts),
      ),
    )
    const items = due
      .filter((_, i) => claimed[i].meta.changes > 0)
      .map((d) => ({ id: d.id, attempts: d.attempts, nextAttemptAt: d.next_attempt_at }))
    await dispatchQueued(env, mode, items, waitUntil, now)
    dispatched = items.length
  } else {
    // processDelivery claims straight from `scheduled`; run inline so the cron's own lifetime covers it.
    for (let i = 0; i < due.length; i += DIRECT_CONCURRENCY) {
      await Promise.all(
        due.slice(i, i + DIRECT_CONCURRENCY).map((d) =>
          processDelivery(env, { deliveryId: d.id, attempt: d.attempts }).catch((err) =>
            console.error('scheduled delivery failed', d.id, err),
          ),
        ),
      )
    }
    dispatched = due.length
  }

  const revived = await env.DB
    .prepare(
      `UPDATE deliveries SET status = 'scheduled', updated_at = ?
       WHERE id IN (SELECT id FROM deliveries WHERE status = 'queued' AND next_attempt_at < ? LIMIT ?)`,
    )
    .bind(now, now - STALE_QUEUED_MS, SCAN_LIMIT)
    .run()

  const leases = await expiredLeases(env.DB, now, SCAN_LIMIT)
  for (const d of leases) {
    await settleAttempt(
      env,
      d,
      { ok: false, retryable: true, retryAfterMs: null, httpStatus: null, responseBody: null, error: '投递中断：尝试超时未完成', durationMs: 0 },
      settings,
      now,
    )
  }

  const { purgedMessages, purgedStats } = await purge(env.DB, settings, now)
  const report = {
    dispatched,
    revived: revived.meta.changes,
    expiredLeases: leases.length,
    purgedMessages,
    purgedStats,
  }
  if (report.dispatched || report.revived || report.expiredLeases || report.purgedMessages || report.purgedStats) {
    console.log(JSON.stringify({ event: 'maintenance', ...report }))
  }
  return report
}

async function purge(db: D1Database, settings: { retentionDays: number; statsRetentionDays: number }, now: number) {
  const last = await db.prepare('SELECT updated_at FROM settings WHERE key = ?').bind(PURGE_KEY).first<{ updated_at: number }>()
  if (last && now - last.updated_at < PURGE_INTERVAL_MS) return { purgedMessages: 0, purgedStats: 0 }
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, '{}', ?)
       ON CONFLICT (key) DO UPDATE SET updated_at = excluded.updated_at`,
    )
    .bind(PURGE_KEY, now)
    .run()

  const cutoff = now - settings.retentionDays * DAY_MS
  let purgedMessages = 0
  for (let i = 0; i < MAX_PURGE_BATCHES; i++) {
    // send_at guards messages scheduled far ahead; deliveries go with their message (FK cascade).
    // RETURNING counts messages only: meta.changes would include the cascaded deliveries.
    const { results } = await db
      .prepare(
        `DELETE FROM messages WHERE id IN (
           SELECT id FROM messages WHERE created_at < ?1 AND send_at < ?1 ORDER BY created_at LIMIT ?2) RETURNING id`,
      )
      .bind(cutoff, PURGE_BATCH)
      .all()
    purgedMessages += results.length
    if (results.length < PURGE_BATCH) break
  }
  const stats = await db
    .prepare('DELETE FROM delivery_stats_hourly WHERE hour < ?')
    .bind(now - settings.statsRetentionDays * DAY_MS)
    .run()
  return { purgedMessages, purgedStats: stats.meta.changes }
}
