import { env } from 'cloudflare:workers'
import { afterEach, expect, it, vi } from 'vitest'
import { adminCall } from './helpers'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
function countedEnv() {
  const prepare = vi.fn((sql: string) => env.DB.prepare(sql))
  const allow = { limit: async () => ({ success: true }) }
  const e = Object.create(env, { DB: { value: { prepare } }, INBOUND_RATE_LIMIT: { value: allow }, INBOUND_TOTAL_LIMIT: { value: allow }, STATS_RATE_LIMIT: { value: allow } }) as CloudflareBindings
  return { e, prepare, aggregates: () => prepare.mock.calls.filter(([sql]) => sql.includes('WITH windows')).length }
}
it('coalesces concurrent stats reads and reuses the response for 60 seconds', async () => {
  vi.useFakeTimers()
  const c = countedEnv()
  const results = await Promise.all(Array.from({length:5}, () => adminCall('/stats?range=90d&tz=UTC', {}, c.e)))
  expect(results.every(r => r.status === 200)).toBe(true)
  expect(c.aggregates()).toBe(1)
  await adminCall('/stats?range=90d&tz=UTC', {}, c.e)
  expect(c.aggregates()).toBe(1)
  await vi.advanceTimersByTimeAsync(60_001)
  await adminCall('/stats?range=90d&tz=UTC', {}, c.e)
  expect(c.aggregates()).toBe(2)
})
it('does not mix ranges, timezones or databases', async () => {
  const a = countedEnv(), b = countedEnv()
  for (const url of ['/stats?range=24h&tz=UTC','/stats?range=90d&tz=UTC','/stats?range=24h&tz=Asia/Taipei'])
    expect((await adminCall(url, {}, a.e)).status).toBe(200)
  expect((await adminCall('/stats?range=24h&tz=UTC', {}, b.e)).status).toBe(200)
  expect(a.aggregates()).toBe(3); expect(b.aggregates()).toBe(1)
})
it('limits statistics before aggregating in D1', async () => {
  const c = countedEnv()
  const e = Object.create(c.e, { STATS_RATE_LIMIT: { value: { limit: async () => ({ success: false }) } } }) as CloudflareBindings
  expect((await adminCall('/stats', {}, e)).status).toBe(429)
  expect(c.prepare).not.toHaveBeenCalled()
})

it('drops failed snapshots so a later request can recover', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const c = countedEnv()
  c.prepare.mockImplementationOnce(() => { throw new Error('temporary D1 failure') })
  expect((await adminCall('/stats', {}, c.e)).status).toBe(500)
  expect((await adminCall('/stats', {}, c.e)).status).toBe(200)
})

it('bounds distinct in-flight snapshots without evicting or duplicating running queries', async () => {
  const { cachedStats, StatsCacheBusyError } = await import('../src/domain/stats-cache')
  const releases: (() => void)[] = []
  const prepare = vi.fn(() => ({
    bind() { return this },
    all: () => new Promise(resolve => releases.push(() => resolve({ results: [] }))),
  }))
  const db = { prepare } as unknown as D1Database
  const zones = ['UTC','Asia/Taipei','Asia/Tokyo','Europe/London']
  const tasks = zones.map(tz => cachedStats(db, '24h', tz))
  try {
    expect(cachedStats(db, '24h', 'UTC')).toBe(tasks[0])
    expect(() => cachedStats(db, '24h', 'America/New_York')).toThrow(StatsCacheBusyError)
    expect(prepare).toHaveBeenCalledTimes(8)
  } finally { releases.forEach(release => release()); await Promise.all(tasks) }
})
