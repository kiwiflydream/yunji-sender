import { env } from 'cloudflare:workers'
import { afterEach, expect, it, vi } from 'vitest'
import { cancelMessage, sendMessage } from '../src/domain/messages'
import { processDelivery } from '../src/delivery/process'
import { adminCall, envWithQueue, mockFetch, setSettings, webhookChannel } from './helpers'

afterEach(() => vi.restoreAllMocks())

it.each([3000, 1])('atomically limits concurrent manual retries with work budget %s', async dailyWorkLimit => {
  await setSettings({ maxPendingDeliveries: 1, dailyWorkLimit })
  const q = envWithQueue(), ch = await webhookChannel(), ids: string[] = []
  for (let i = 0; i < 3; i++) {
    const m = await sendMessage(q.env, { channels: [ch.id], body: 'test' }, { source: 'admin', waitUntil: () => {} })
    ids.push(m.deliveries[0].id)
    await cancelMessage(env.DB, m.messageId)
  }
  const responses = await Promise.all(ids.map(id => adminCall(`/deliveries/${id}/retry`, { method: 'POST' }, q.env)))
  expect(responses.filter(r => r.status === 202)).toHaveLength(1)
  expect(responses.filter(r => r.status === 429)).toHaveLength(2)
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM deliveries WHERE status IN ('scheduled','queued','sending')").first()).toEqual({ n: 1 })
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM deliveries WHERE status='canceled'").first()).toEqual({ n: 2 })
})

it('rolls back failure statistics when a full backlog rejects a retry', async () => {
  await setSettings({ maxPendingDeliveries: 1 })
  const q = envWithQueue(), ch = await webhookChannel()
  const fetch = mockFetch(() => new Response('bad', { status: 400 }))
  const failed = await sendMessage(q.env, { channels: [ch.id], body: 'test' }, { source: 'admin', waitUntil: () => {} })
  await processDelivery(q.env, q.sent[0].body)
  await sendMessage(q.env, { channels: [ch.id], body: 'occupy capacity' }, { source: 'admin', waitUntil: () => {} })
  const id = failed.deliveries[0].id
  const before = await env.DB.prepare('SELECT * FROM deliveries WHERE id=?').bind(id).first()
  const stats = await env.DB.prepare('SELECT * FROM delivery_stats').all()
  const response = await adminCall(`/deliveries/${id}/retry`, { method: 'POST' }, q.env)
  expect(response.status).toBe(429)
  expect(await response.json()).toEqual({ error: 'safety_limit', reason: 'backlog' })
  expect(await env.DB.prepare('SELECT * FROM deliveries WHERE id=?').bind(id).first()).toEqual(before)
  expect((await env.DB.prepare('SELECT * FROM delivery_stats').all()).results).toEqual(stats.results)
  expect(q.sent).toHaveLength(2)
  expect(fetch).toHaveLength(1)
})
