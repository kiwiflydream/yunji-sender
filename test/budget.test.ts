import { env } from 'cloudflare:workers'
import { afterEach, expect, it, vi } from 'vitest'
import { DIRECT_BATCH_LIMIT } from '../src/delivery/limits'
import { sendMessage } from '../src/domain/messages'
import { runMaintenance } from '../src/maintenance/maintenance'
import { apiCall, apiKey, channelGroupWith, mockFetch, setSettings, webhookChannel } from './helpers'

afterEach(() => vi.restoreAllMocks())

/** Count each SQL statement and outbound fetch conservatively against the invocation budget. */
function invocation() {
  let used = 0
  const consume = (count = 1) => {
    used += count
    if (used > 50) throw new Error('simulated Free invocation limit exceeded')
  }
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>()
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values))
        const value = Reflect.get(target, property, target)
        if (['first', 'all', 'run', 'raw'].includes(String(property))) {
          return (...args: unknown[]) => { consume(); return Reflect.apply(value, target, args) }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    originals.set(proxy, statement)
    return proxy
  }
  const db = {
    prepare: (sql: string) => wrap(env.DB.prepare(sql)),
    batch: (statements: D1PreparedStatement[]) => {
      consume(statements.length)
      return env.DB.batch(statements.map((s) => originals.get(s) ?? s))
    },
  }
  return {
    env: Object.create(env, { DB: { value: db } }) as CloudflareBindings,
    consume,
    used: () => used,
  }
}

it.each(['direct', 'queue'] as const)('accepts a 100-target %s fan-out within budget, including queue failure recovery', async (mode) => {
  await setSettings({ executionMode: mode, maxAttempts: 1 })
  const channels = []
  for (let i = 0; i < 100; i++) channels.push(await webhookChannel(`hook-${i}`))
  await channelGroupWith('many', channels.slice(0, 50).map((c) => c.id))
  const key = await apiKey()
  const call = invocation()
  let rejected = 0
  const executionEnv = mode === 'direct' ? call.env : Object.create(call.env, { DELIVERY_QUEUE: { value: {
    sendBatch: async (items: Iterable<unknown>) => {
      call.consume()
      rejected = [...items].length
      throw new Error('simulated queue outage')
    },
  } } }) as CloudflareBindings
  const fetches = mockFetch((request) => {
    expect(request.redirect).toBe('manual')
    call.consume()
    return new Response('ok')
  })
  const response = await apiCall(key, '/send', { method: 'POST', body: JSON.stringify({
    channelGroup: 'many', channels: channels.slice(50).map((c) => c.id), body: 'test',
  }) }, executionEnv)
  expect(response.status).toBe(202)
  const sent = mode === 'direct' ? DIRECT_BATCH_LIMIT : 0
  expect(fetches).toHaveLength(sent)
  expect(rejected).toBe(mode === 'queue' ? 100 : 0)
  expect(call.used()).toBeLessThanOrEqual(50)
  const { results } = await env.DB.prepare('SELECT status, attempts, COUNT(*) n FROM deliveries GROUP BY status, attempts').all()
  expect(results).toHaveLength(sent ? 2 : 1)
  expect(results).toContainEqual({ status: 'scheduled', attempts: 0, n: 100 - sent })
  if (sent) expect(results).toContainEqual({ status: 'sent', attempts: 1, n: sent })
})

it('drains a 51-message direct backlog across bounded invocations without spending retries on overflow', async () => {
  await setSettings({ executionMode: 'direct', maxAttempts: 1 })
  const channel = await webhookChannel()
  const before = Date.now() - 60_000
  for (let i = 0; i < 51; i++) {
    await sendMessage(env, { channels: [channel.id], body: 'test', sendAt: before + 1000 }, {
      source: 'admin', now: before, waitUntil: () => { throw new Error('fixture must remain scheduled') },
    })
  }
  for (let remaining = 51; remaining > 0; remaining -= DIRECT_BATCH_LIMIT) {
    const call = invocation()
    const fetches = mockFetch(() => { call.consume(); return new Response('ok') })
    await runMaintenance(call.env, () => {})
    expect(fetches).toHaveLength(Math.min(remaining, DIRECT_BATCH_LIMIT))
    expect(call.used()).toBeLessThanOrEqual(50)
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM deliveries WHERE status='failed' OR attempts > 1").first()).toEqual({ n: 0 })
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM deliveries WHERE status='scheduled' AND attempts=0").first()).toEqual({ n: Math.max(0, remaining - DIRECT_BATCH_LIMIT) })
    vi.restoreAllMocks()
  }
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM deliveries WHERE status='sent'").first()).toEqual({ n: 51 })
})

it('stays within budget when direct sends, expired leases and five purge batches coincide', async () => {
  await setSettings({ executionMode: 'direct', maxAttempts: 1 })
  const channel = await webhookChannel()
  const now = Date.now()
  for (let i = 0; i < DIRECT_BATCH_LIMIT + 3; i++) {
    await sendMessage(env, { channels: [channel.id], body: 'test', sendAt: now - 1000 }, {
      source: 'admin', now: now - 2000, waitUntil: () => { throw new Error('fixture must remain scheduled') },
    })
  }
  await env.DB.prepare(`UPDATE deliveries SET status='sending', attempts=1, lease_until=?
    WHERE id IN (SELECT id FROM deliveries ORDER BY id LIMIT 3)`).bind(now - 1).run()
  const old = now - 31 * 24 * 60 * 60_000
  await env.DB.prepare(`INSERT INTO messages (id,source,payload,send_at,created_at)
    SELECT value,'admin','{}',?1,?1 FROM json_each(?2)`)
    .bind(old, JSON.stringify(Array.from({ length: 2501 }, () => crypto.randomUUID()))).run()
  const call = invocation()
  const fetches = mockFetch(() => { call.consume(); return new Response('ok') })
  const report = await runMaintenance(call.env, () => {}, now)
  expect(report).toMatchObject({ dispatched: DIRECT_BATCH_LIMIT, expiredLeases: 2, purgedMessages: 2500 })
  expect(fetches).toHaveLength(DIRECT_BATCH_LIMIT)
  expect(call.used()).toBeLessThanOrEqual(50)
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM deliveries WHERE status='sending'").first()).toEqual({ n: 1 })
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM deliveries WHERE status='failed'").first()).toEqual({ n: 2 })
})
