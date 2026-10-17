import { zonedTimeToEpoch } from '../lib/time'
import type {
  ChannelType,
  StatsBreakdownRow,
  StatsGranularity,
  StatsOverview,
  StatsRange,
  StatsSummary,
} from '../shared/types'
import { HOUR_MS } from '../delivery/repo'

export const STATS_RANGES = ['24h', '7d', '30d', '90d'] as const satisfies readonly StatsRange[]

export interface Agg {
  sent: number
  failed: number
  retries: number
  latencySum: number
  latencyMax: number
}

export const emptyAgg = (): Agg => ({ sent: 0, failed: 0, retries: 0, latencySum: 0, latencyMax: 0 })

export function addAgg(into: Agg, a: Agg): Agg {
  into.sent += a.sent
  into.failed += a.failed
  into.retries += a.retries
  into.latencySum += a.latencySum
  into.latencyMax = Math.max(into.latencyMax, a.latencyMax)
  return into
}

export function summarize(a: Agg): StatsSummary {
  const total = a.sent + a.failed
  return {
    total,
    sent: a.sent,
    failed: a.failed,
    successRate: total === 0 ? null : a.sent / total,
    retries: a.retries,
    latencyAvg: a.sent === 0 ? null : Math.round(a.latencySum / a.sent),
    latencyMax: a.sent === 0 ? null : a.latencyMax,
  }
}

export interface StatsWindow {
  range: StatsRange
  granularity: StatsGranularity
  from: number
  to: number
  /** Ascending bucket start times; the last bucket contains `to`. */
  buckets: number[]
}

function localDate(epochMs: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(epochMs),
  )
}

/** 24h / 7d are hourly; 30d / 90d are local calendar days in `tz`, today included. */
export function statsWindow(range: StatsRange, now: number, tz: string): StatsWindow {
  if (range === '24h' || range === '7d') {
    const hours = range === '24h' ? 24 : 7 * 24
    const last = now - (now % HOUR_MS)
    const buckets = Array.from({ length: hours }, (_, i) => last - (hours - 1 - i) * HOUR_MS)
    return { range, granularity: 'hour', from: buckets[0], to: now, buckets }
  }
  const days = range === '30d' ? 30 : 90
  const [y, m, d] = localDate(now, tz).split('-').map(Number)
  const buckets = Array.from({ length: days }, (_, i) => {
    const date = new Date(Date.UTC(y, m - 1, d - (days - 1 - i))).toISOString().slice(0, 10)
    return zonedTimeToEpoch(`${date}T00:00`, tz)!
  })
  return { range, granularity: 'day', from: buckets[0], to: now, buckets }
}

/** Index of the last bucket starting at or before `t`. */
function bucketOf(buckets: number[], t: number): number {
  let lo = 0
  let hi = buckets.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (buckets[mid] <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

export interface StatsRow {
  hour: number
  channel_id: string
  channel_group_slug: string
  sent: number
  failed: number
  retries: number
  latency_sum: number
  latency_max: number
}

const toAgg = (r: StatsRow): Agg => ({
  sent: r.sent,
  failed: r.failed,
  retries: r.retries,
  latencySum: r.latency_sum,
  latencyMax: r.latency_max,
})

function breakdown(groups: Map<string, Agg>, label: (key: string) => { label: string; type?: ChannelType }): StatsBreakdownRow[] {
  return [...groups.entries()]
    .map(([key, agg]) => {
      const s = summarize(agg)
      return { key, ...label(key), total: s.total, sent: s.sent, failed: s.failed, successRate: s.successRate, latencyAvg: s.latencyAvg }
    })
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
}

export function buildOverview(
  window: StatsWindow,
  rows: StatsRow[],
  channels: Map<string, { name: string; type: ChannelType }>,
): StatsOverview {
  const total = emptyAgg()
  const buckets = window.buckets.map(() => emptyAgg())
  const byChannel = new Map<string, Agg>()
  const byChannelGroup = new Map<string, Agg>()
  for (const r of rows) {
    if (r.hour < window.from || r.hour > window.to) continue
    const agg = toAgg(r)
    addAgg(total, agg)
    addAgg(buckets[bucketOf(window.buckets, r.hour)], agg)
    addAgg(byChannel.get(r.channel_id) ?? byChannel.set(r.channel_id, emptyAgg()).get(r.channel_id)!, agg)
    addAgg(byChannelGroup.get(r.channel_group_slug) ?? byChannelGroup.set(r.channel_group_slug, emptyAgg()).get(r.channel_group_slug)!, agg)
  }
  return {
    range: window.range,
    granularity: window.granularity,
    from: window.from,
    to: window.to,
    summary: summarize(total),
    series: buckets.map((a, i) => ({ t: window.buckets[i], sent: a.sent, failed: a.failed, latencyAvg: summarize(a).latencyAvg })),
    byChannel: breakdown(byChannel, (id) => {
      const c = channels.get(id)
      return c ? { label: c.name, type: c.type } : { label: `已删除（${id.slice(0, 8)}）` }
    }),
    byChannelGroup: breakdown(byChannelGroup, (slug) => ({ label: slug || '（直接指定渠道）' })),
  }
}

export async function statsOverview(db: D1Database, window: StatsWindow): Promise<StatsOverview> {
  const [rows, channels] = await Promise.all([
    db
      .prepare('SELECT * FROM delivery_stats_hourly WHERE hour >= ? AND hour <= ?')
      .bind(window.from, window.to)
      .all<StatsRow>(),
    db.prepare('SELECT id, name, type FROM channels').all<{ id: string; name: string; type: ChannelType }>(),
  ])
  return buildOverview(window, rows.results, new Map(channels.results.map((c) => [c.id, c])))
}
