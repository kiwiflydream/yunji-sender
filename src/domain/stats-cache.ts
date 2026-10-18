import { statsOverview, statsWindow } from './stats'
import type { StatsOverview, StatsRange } from '../shared/types'
import { OperationTimeoutError, withTimeout } from '../lib/timeout'

const TTL_MS = 60_000
const MAX_ENTRIES = 16
const MAX_IN_FLIGHT = 4
const MAX_RESULT_CHARS = 128 * 1024
interface Entry { promise: Promise<StatsOverview>; expiresAt: number; pending: boolean }
const caches = new WeakMap<D1Database, Map<string, Entry>>()
export class StatsCacheBusyError extends Error {}

/** Also useful when replacing/resetting the backing database in local tests. */
export function clearStatsCache(db: D1Database): void { caches.delete(db) }

/** Isolate-local, bounded snapshots; authentication remains outside this cache. */
export function cachedStats(db: D1Database, range: StatsRange, tz: string): Promise<StatsOverview> {
  const timezone = new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone
  const key = `${range}:${timezone}`
  let cache = caches.get(db)
  if (!cache) { cache = new Map(); caches.set(db, cache) }
  const now = Date.now()
  for (const [k, entry] of cache) if (!entry.pending && entry.expiresAt <= now) cache.delete(k)
  const hit = cache.get(key)
  if (hit) return hit.promise
  if ([...cache.values()].filter(e => e.pending).length >= MAX_IN_FLIGHT) throw new StatsCacheBusyError()
  if (cache.size >= MAX_ENTRIES) {
    const oldest = [...cache].find(([, e]) => !e.pending)
    if (oldest) cache.delete(oldest[0])
  }
  const entries = cache
  const entry: Entry = { pending: true, expiresAt: Infinity, promise: undefined! }
  entry.promise = withTimeout(statsOverview(db, statsWindow(range, now, timezone)), 10_000).then(result => {
    entry.pending = false
    entry.expiresAt = Date.now() + TTL_MS
    // Large reports may be returned, but must not accumulate in the cache.
    if (JSON.stringify(result).length > MAX_RESULT_CHARS) entries.delete(key)
    return result
  }).catch(error => {
    entries.delete(key)
    if (error instanceof OperationTimeoutError) throw new StatsCacheBusyError()
    throw error
  })
  entries.set(key, entry)
  return entry.promise
}
