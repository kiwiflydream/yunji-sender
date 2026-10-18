import { env } from 'cloudflare:workers'
import { afterEach, expect, it, vi } from 'vitest'
import { sendMessage } from '../src/domain/messages'
import { processDelivery } from '../src/delivery/process'
import { DEFAULT_RUNTIME_SETTINGS } from '../src/shared/types'
import { runMaintenance, STALE_QUEUED_MS } from '../src/maintenance/maintenance'
import { adminCall, apiCall, apiKey, envWithQueue, mockFetch, setSettings, webhookChannel } from './helpers'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const noWait = () => {}

it('does not immediately revive a freshly republished overdue queue message', async () => {
  const q = envWithQueue()
  const ch = await webhookChannel()
  const now = Date.now()
  const sent = await sendMessage(q.env, { channels: [ch.id], body: 'test' }, { source: 'admin', waitUntil: noWait, now })
  await runMaintenance(q.env, noWait, now + STALE_QUEUED_MS + 1000)
  const report = await runMaintenance(q.env, noWait, now + STALE_QUEUED_MS + 61_000)
  expect(report.dispatched).toBe(1)
  expect(report.revived).toBe(0)
  expect(await env.DB.prepare('SELECT status FROM deliveries WHERE id=?').bind(sent.deliveries[0].id).first()).toEqual({ status: 'queued' })
})

it('terminates persistent enqueue failure without consuming unlimited cron dispatches', async () => {
  await setSettings({ maxAttempts: 1 })
  let calls = 0
  const e = Object.create(env, { DELIVERY_QUEUE: { value: { sendBatch: async () => { calls++; throw new Error('queue unavailable') } } } }) as CloudflareBindings
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const ch = await webhookChannel()
  const now = Date.now()
  await sendMessage(e, { channels: [ch.id], body: 'test' }, { source: 'admin', waitUntil: noWait, now })
  for (let i = 1; i <= 30; i++) await runMaintenance(e, noWait, now + i * 3600_000)
  expect(calls).toBeLessThanOrEqual(12)
  expect(await env.DB.prepare('SELECT status FROM deliveries').first()).toEqual({ status: 'failed' })
  expect(await env.DB.prepare('SELECT failed,retries FROM delivery_stats').first()).toEqual({ failed: 1, retries: 0 })
})

it.each([
  ['dailyDeliveryLimit', 'daily'], ['perKeyDailyDeliveryLimit', 'key_daily'],
  ['perKeyMinuteLimit', 'rate'], ['maxPendingDeliveries', 'backlog'],
] as const)('enforces %s and rolls back rejected admission reservations', async (setting, reason) => {
  await setSettings({ [setting]: 2 })
  const q = envWithQueue()
  const ch = await webhookChannel()
  const key = await apiKey()
  const input = { method: 'POST', body: JSON.stringify({ channels: [ch.id], body: 'same event' }) }
  expect((await apiCall(key, '/send', input, q.env)).status).toBe(202)
  expect((await apiCall(key, '/send', input, q.env)).status).toBe(202)
  const denied = await apiCall(key, '/send', input, q.env)
  expect(denied.status).toBe(429)
  expect(await denied.json()).toEqual({ error: 'safety_limit', reason })
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM messages').first()).toEqual({ n: 2 })
  expect((await env.DB.prepare("SELECT used FROM usage_counters WHERE kind LIKE 'accepted%'").all()).results)
    .toEqual([{ used: 2 }, { used: 2 }, { used: 2 }])
  expect(q.sent).toHaveLength(2)
})

it('reserves fan-out quota atomically under concurrent API requests', async () => {
  await setSettings({ dailyDeliveryLimit: 7 })
  const q = envWithQueue()
  const ch = await webhookChannel()
  const key = await apiKey()
  const responses = await Promise.all(Array.from({ length: 12 }, () => apiCall(key, '/send', {
    method: 'POST', body: JSON.stringify({ channels: [ch.id], body: 'concurrent' }),
  }, q.env)))
  expect(responses.filter((r) => r.status === 202)).toHaveLength(7)
  expect(responses.filter((r) => r.status === 429)).toHaveLength(5)
  expect(q.sent).toHaveLength(7)
})

it('charges each fan-out target and preserves idempotency when the quota is full', async () => {
  await setSettings({ dailyDeliveryLimit: 2 })
  const q = envWithQueue()
  const a = await webhookChannel('a'), b = await webhookChannel('b')
  const input = { channels: [a.id, b.id], body: 'fanout' }
  const responses = await Promise.all(Array.from({ length: 5 }, () => sendMessage(q.env, input, {
    source: 'rpc', idempotencyKey: 'once', waitUntil: noWait,
  })))
  expect(new Set(responses.map((r) => r.messageId)).size).toBe(1)
  expect(q.sent).toHaveLength(2)
  await expect(sendMessage(q.env, input, { source: 'rpc', waitUntil: noWait })).rejects.toThrow('safety:daily')
})

it('shares the daily work budget across enqueue, actual attempts and automatic retries', async () => {
  await setSettings({ dailyWorkLimit: 2 })
  const q = envWithQueue()
  const ch = await webhookChannel()
  const calls = mockFetch(() => new Response('down', { status: 503 }))
  await sendMessage(q.env, { channels: [ch.id], body: 'test' }, { source: 'admin', waitUntil: noWait })
  await processDelivery(q.env, q.sent[0].body)
  expect(calls).toHaveLength(1)
  expect(q.sent).toHaveLength(1)
  expect(await env.DB.prepare('SELECT status,attempts,dispatch_count,error FROM deliveries').first())
    .toEqual({ status: 'scheduled', attempts: 1, dispatch_count: 1, error: 'safety:work' })
  expect(await env.DB.prepare("SELECT used FROM usage_counters WHERE kind='work'").first()).toEqual({ used: 2 })
  // Duplicate transport messages cannot start a further attempt or reserve budget.
  await processDelivery(q.env, q.sent[0].body)
  expect(calls).toHaveLength(1)
})

it('pauses admission, already queued work and channel tests without burning attempts', async () => {
  const q = envWithQueue()
  const ch = await webhookChannel()
  const key = await apiKey()
  await sendMessage(q.env, { channels: [ch.id], body: 'test' }, { source: 'admin', waitUntil: noWait })
  await setSettings({ sendingPaused: true })
  const calls = mockFetch()
  await processDelivery(q.env, q.sent[0].body)
  expect(await env.DB.prepare('SELECT status,attempts FROM deliveries').first()).toEqual({ status: 'scheduled', attempts: 0 })
  expect((await apiCall(key, '/send', { method: 'POST', body: JSON.stringify({ channels: [ch.id], body: 'test' }) }, q.env)).status).toBe(503)
  await expect(sendMessage(q.env, { channels: [ch.id], body: 'test' }, { source: 'rpc', waitUntil: noWait })).rejects.toThrow('safety:paused')
  expect((await adminCall(`/channels/${ch.id}/test`, { method: 'POST' })).status).toBe(503)
  expect((await runMaintenance(q.env, noWait)).dispatched).toBe(0)
  expect(calls).toHaveLength(0)
})

it('resets admission quotas at the UTC day boundary and keeps future schedules alive', async () => {
  await setSettings({ dailyDeliveryLimit: 1 })
  const q = envWithQueue()
  const ch = await webhookChannel()
  const now = Date.now(), midnight = now - now % 86400000 + 86400000
  const body = { channels: [ch.id], body: 'tomorrow', sendAt: now + 7 * 86400000 }
  await sendMessage(q.env, body, { source: 'rpc', waitUntil: noWait, now })
  await expect(sendMessage(q.env, body, { source: 'rpc', waitUntil: noWait, now })).rejects.toThrow('safety:daily')
  await sendMessage(q.env, body, { source: 'rpc', waitUntil: noWait, now: midnight })
  await runMaintenance(q.env, noWait, midnight)
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM deliveries WHERE status='scheduled'").first()).toEqual({ n: 2 })
})

it('requires complete settings and keeps stored limits unchanged on invalid updates', async () => {
  await setSettings({ sendingPaused: true, dailyWorkLimit: 17 })
  const response = await adminCall('/settings/runtime', { method: 'PUT', body: JSON.stringify({
    executionMode: 'queue', maxAttempts: 2, retentionDays: 7, statsRetentionDays: 30,
  }) })
  expect(response.status).toBe(422)
  expect(await (await adminCall('/settings/runtime')).json())
    .toMatchObject({ settings: { sendingPaused: true, dailyWorkLimit: 17 } })
})

it('provides defaults before settings are first saved', async () => {
  await env.DB.prepare("DELETE FROM settings WHERE key='runtime'").run()
  expect(await (await adminCall('/settings/runtime')).json()).toEqual({ settings: DEFAULT_RUNTIME_SETTINGS })
})

it('bounds a stalled enqueue wait and retains a reservation for its unknown outcome', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const ch = await webhookChannel()
  let release!: () => void
  const queue = { sendBatch: vi.fn(() => new Promise<void>(resolve => { release = resolve })) }
  const e = Object.create(env, { DELIVERY_QUEUE: { value: queue } }) as CloudflareBindings
  const task = sendMessage(e, { channels: [ch.id], body: 'test' }, { source: 'admin', waitUntil: noWait })
  // Let the D1 reservation finish before advancing the operation timer.
  await vi.waitFor(() => expect(queue.sendBatch).toHaveBeenCalledTimes(1))
  try {
    await vi.advanceTimersByTimeAsync(10_001)
    const result = await task
    expect(result.deliveries[0].status).toBe('scheduled')
    expect(await env.DB.prepare('SELECT dispatch_count,attempts FROM deliveries').first()).toEqual({ dispatch_count: 1, attempts: 0 })
  } finally { release(); await task }
})

it('counts direct sends and channel tests against the same work budget', async () => {
  await setSettings({ executionMode: 'direct', dailyWorkLimit: 1 })
  const ch = await webhookChannel()
  const calls = mockFetch(() => new Response('ok'))
  expect((await adminCall(`/channels/${ch.id}/test`, { method: 'POST' })).status).toBe(200)
  const pending: Promise<unknown>[] = []
  await sendMessage(env, { channels: [ch.id], body: 'test' }, { source: 'admin', waitUntil: (p) => { pending.push(p) } })
  await Promise.all(pending)
  expect(calls).toHaveLength(1)
  expect(await env.DB.prepare('SELECT attempts,status FROM deliveries').first()).toEqual({ attempts: 0, status: 'scheduled' })
})

it('expires paused work once at its deadline and allows an explicitly requested fresh retry', async () => {
  const q = envWithQueue()
  const ch = await webhookChannel()
  const now = Date.now()
  const sent = await sendMessage(q.env, { channels: [ch.id], body: 'test' }, { source: 'admin', waitUntil: noWait, now })
  await setSettings({ sendingPaused: true })
  const end = now + 86400000
  await runMaintenance(q.env, noWait, end)
  await runMaintenance(q.env, noWait, end + 60_000)
  expect(await env.DB.prepare('SELECT status,attempts FROM deliveries').first()).toEqual({ status: 'failed', attempts: 0 })
  expect(await env.DB.prepare('SELECT failed,retries FROM delivery_stats').first()).toEqual({ failed: 1, retries: 0 })
  expect(q.sent).toHaveLength(1)
  await setSettings({ sendingPaused: false })
  const response = await adminCall(`/deliveries/${sent.deliveries[0].id}/retry`, { method: 'POST' }, q.env)
  expect(response.status).toBe(202)
  expect(q.sent).toHaveLength(2)
  expect(await env.DB.prepare('SELECT status,dispatch_count FROM deliveries').first()).toEqual({ status: 'queued', dispatch_count: 1 })
  expect(await env.DB.prepare('SELECT failed,retries FROM delivery_stats').first()).toEqual({ failed: 0, retries: 0 })
})
