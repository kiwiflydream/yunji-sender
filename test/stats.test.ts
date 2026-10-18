import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { claimDelivery, finishDelivery, reopenDelivery } from '../src/delivery/repo'
import { statsOverview, statsWindow } from '../src/domain/stats'
import { formatInZone, zonedTimeToEpoch } from '../src/lib/time'
import { runMaintenance, DAY_MS } from '../src/maintenance/maintenance'
import { setSettings } from './helpers'

async function outcome(sendAt: number, status: 'sent' | 'failed' = 'sent') {
  const id = crypto.randomUUID()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO messages (id, source, payload, send_at, created_at) VALUES (?, 'admin', '{}', ?, ?)").bind(id, sendAt, sendAt),
    env.DB.prepare(`INSERT INTO deliveries (id, message_id, channel_id, channel_type, channel_name, channel_group_slug,
      status, next_attempt_at, created_at, updated_at) VALUES (?, ?, 'c', 'webhook', 'test', 'ops', 'queued', ?, ?, ?)`)
      .bind(id, id, sendAt, sendAt, sendAt),
  ])
  const delivery = (await claimDelivery(env.DB, id, 0, sendAt))!
  await finishDelivery(env.DB, delivery, status, { durationMs: 1, httpStatus: 200, responseBody: null, error: null }, sendAt + 1000)
  return id
}

it.each(['Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Eucla', 'Pacific/Chatham'])(
  'assigns midnight outcomes and the first day correctly in %s', async (tz) => {
    const window = statsWindow('30d', Date.parse('2026-10-18T12:00:00Z'), tz)
    const midnight = window.buckets.at(-1)!
    await outcome(midnight - 60_000)
    await outcome(midnight + 60_000)
    await outcome(window.from - 60_000) // Must be excluded, even in the same UTC hour.
    await outcome(window.from + 60_000)
    const stats = await statsOverview(env.DB, window)
    expect(stats.summary).toMatchObject({ total: 3, sent: 3, failed: 0, latencyAvg: 1000 })
    expect(stats.series[0].sent).toBe(1)
    expect(stats.series.at(-2)!.sent).toBe(1)
    expect(stats.series.at(-1)!.sent).toBe(1)
    expect(stats.series.reduce((n, p) => n + p.sent, 0)).toBe(stats.summary.sent)
  },
)

it.each([
  ['2026-03-09T12:00:00Z', '2026-03-08', 23],
  ['2026-11-02T12:00:00Z', '2026-11-01', 25],
] as const)('keeps DST calendar days correct around %s', async (now, date, hours) => {
  const tz = 'America/New_York'
  const window = statsWindow('30d', Date.parse(now), tz)
  const midnight = zonedTimeToEpoch(`${date}T00:00`, tz)!
  const i = window.buckets.indexOf(midnight)
  expect(window.buckets[i + 1] - midnight).toBe(hours * 60 * 60_000)
  await outcome(midnight - 60_000)
  await outcome(midnight)
  await outcome(window.buckets[i + 1] - 60_000)
  await outcome(window.buckets[i + 1])
  const stats = await statsOverview(env.DB, window)
  expect(stats.series[i - 1].sent).toBe(1)
  expect(stats.series[i].sent).toBe(2)
  expect(stats.series[i + 1].sent).toBe(1)
})

it('replaces a failure in its original minute bucket on manual retry', async () => {
  const now = Date.parse('2026-10-18T12:00:00Z')
  const window = statsWindow('30d', now, 'Asia/Kolkata')
  const sendAt = window.buckets.at(-1)! + 5 * 60_000
  const id = await outcome(sendAt, 'failed')
  expect((await statsOverview(env.DB, window)).summary.failed).toBe(1)
  expect(await reopenDelivery(env.DB, id, 'queued', sendAt + 2000)).toEqual({ attempts: 1 })
  expect((await statsOverview(env.DB, window)).summary.total).toBe(0)
  const claimed = (await claimDelivery(env.DB, id, 1, sendAt + 3000))!
  await finishDelivery(env.DB, claimed, 'sent', { durationMs: 1, httpStatus: 200, responseBody: null, error: null }, sendAt + 4000)
  expect((await statsOverview(env.DB, window)).summary).toMatchObject({ total: 1, sent: 1, failed: 0, retries: 1, latencyAvg: 4000 })
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM delivery_stats').first()).toEqual({ n: 1 })
})

it('retains minute statistics after message retention removes the source records', async () => {
  await setSettings({ executionMode: 'direct', retentionDays: 30, statsRetentionDays: 90 })
  const now = Date.now()
  await outcome(now - 40 * DAY_MS)
  const report = await runMaintenance(env, () => {}, now)
  expect(report).toMatchObject({ purgedMessages: 1, purgedStats: 0 })
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM deliveries').first()).toEqual({ n: 0 })
  expect((await statsOverview(env.DB, statsWindow('90d', now, 'Asia/Kathmandu'))).summary.sent).toBe(1)
})

it.each([
  ['America/Santiago', '2026-09-07T12:00:00Z', '2026-09-06', '2026-09-06T04:00:00Z', 23],
  ['Asia/Amman', '2021-10-30T12:00:00Z', '2021-10-29', '2021-10-28T21:00:00Z', 25],
] as const)('uses the first real instant of a calendar day when midnight jumps or repeats in %s', async (tz, now, date, start, hours) => {
  const window = statsWindow('30d', Date.parse(now), tz)
  const i = window.buckets.findIndex((t) => formatInZone(t, tz).startsWith(date))
  expect(window.buckets[i]).toBe(Date.parse(start))
  expect(window.buckets[i + 1] - window.buckets[i]).toBe(hours * 60 * 60_000)
  await outcome(Date.parse(start) - 60_000)
  await outcome(Date.parse(start))
  const stats = await statsOverview(env.DB, window)
  expect(stats.series[i - 1].sent).toBe(1)
  expect(stats.series[i].sent).toBe(1)
})
