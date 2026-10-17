import { createExecutionContext, createMessageBatch, createScheduledController, getQueueResult, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteChannel } from '../src/domain/channels'
import { sendMessage } from '../src/domain/messages'
import type { DeliveryMessage } from '../src/delivery/mode'
import { BACKOFF_SECONDS, handleDeliveryBatch, processDelivery, retryDelayMs } from '../src/delivery/process'
import { LEASE_MS } from '../src/delivery/repo'
import worker from '../src/index'
import { runMaintenance, STALE_QUEUED_MS } from '../src/maintenance/maintenance'
import { adminCall, envWithQueue, mockFetch, setSettings, webhookChannel } from './helpers'

afterEach(() => vi.restoreAllMocks())

const noWait = () => {}

async function delivery(id: string) {
  return (await env.DB.prepare('SELECT * FROM deliveries WHERE id = ?').bind(id).first<any>())!
}

async function stats() {
  return env.DB.prepare('SELECT sent, failed, retries FROM delivery_stats_hourly').all<{ sent: number; failed: number; retries: number }>()
    .then((r) => r.results)
}

/** A message to one webhook channel, queued (recorded, not delivered). */
async function queuedDelivery(e = envWithQueue(), body: Record<string, unknown> = {}) {
  const ch = await webhookChannel('hook', 'https://hooks.test/secret-token-abc')
  const result = await sendMessage(e.env, { channels: [ch.id], title: 'hi', body: 'there', ...body }, { source: 'admin', waitUntil: noWait })
  return { ...e, channel: ch, deliveryId: result.deliveries[0].id, messageId: result.messageId }
}

describe('processDelivery', () => {
  it('records success with stats and latency', async () => {
    const calls = mockFetch(() => new Response('{"received":true}'))
    const { env: e, deliveryId } = await queuedDelivery()
    await processDelivery(e, { deliveryId, attempt: 0 })
    expect(calls).toHaveLength(1)
    expect(await delivery(deliveryId)).toMatchObject({ status: 'sent', attempts: 1, http_status: 200, error: null, response_body: '{"received":true}' })
    expect(await stats()).toEqual([{ sent: 1, failed: 0, retries: 0 }])
  })

  it('ignores duplicates and stale attempts', async () => {
    const calls = mockFetch(() => new Response('ok'))
    const { env: e, deliveryId } = await queuedDelivery()
    await processDelivery(e, { deliveryId, attempt: 0 })
    await processDelivery(e, { deliveryId, attempt: 0 })
    await processDelivery(e, { deliveryId, attempt: 1 })
    expect(calls).toHaveLength(1)
    expect(await stats()).toEqual([{ sent: 1, failed: 0, retries: 0 }])
  })

  it('retries retryable failures on the queue with backoff, then fails for good', async () => {
    await setSettings({ maxAttempts: 3 })
    mockFetch(() => new Response('down', { status: 503 }))
    const q = await queuedDelivery()
    q.sent.length = 0
    await processDelivery(q.env, { deliveryId: q.deliveryId, attempt: 0 })
    expect(await delivery(q.deliveryId)).toMatchObject({ status: 'queued', attempts: 1, http_status: 503, error: 'HTTP 503' })
    expect(q.sent).toEqual([{ body: { deliveryId: q.deliveryId, attempt: 1 }, delaySeconds: BACKOFF_SECONDS[0] }])

    await processDelivery(q.env, { deliveryId: q.deliveryId, attempt: 1 })
    expect(q.sent[1]).toEqual({ body: { deliveryId: q.deliveryId, attempt: 2 }, delaySeconds: BACKOFF_SECONDS[1] })
    await processDelivery(q.env, { deliveryId: q.deliveryId, attempt: 2 })
    expect(await delivery(q.deliveryId)).toMatchObject({ status: 'failed', attempts: 3 })
    expect(q.sent).toHaveLength(2)
    expect(await stats()).toEqual([{ sent: 0, failed: 1, retries: 2 }])
  })

  it('honors Retry-After and fails non-retryable errors immediately', async () => {
    mockFetch(() => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }))
    const q = await queuedDelivery()
    q.sent.length = 0
    await processDelivery(q.env, { deliveryId: q.deliveryId, attempt: 0 })
    expect(q.sent[0].delaySeconds).toBe(120)

    vi.restoreAllMocks()
    mockFetch(() => new Response('nope', { status: 404 }))
    await processDelivery(q.env, { deliveryId: q.deliveryId, attempt: 1 })
    expect(await delivery(q.deliveryId)).toMatchObject({ status: 'failed', attempts: 2, error: 'HTTP 404' })
  })

  it('keeps retries in D1 for the cron in direct mode', async () => {
    mockFetch(() => new Response('down', { status: 500 }))
    const { deliveryId } = await queuedDelivery()
    await setSettings({ executionMode: 'direct' })
    const before = Date.now()
    await processDelivery(env, { deliveryId, attempt: 0 })
    const d = await delivery(deliveryId)
    expect(d.status).toBe('scheduled')
    expect(d.next_attempt_at).toBeGreaterThanOrEqual(before + BACKOFF_SECONDS[0] * 1000)
  })

  it('fails deliveries whose channel was deleted, and redacts secrets', async () => {
    const q = await queuedDelivery()
    await deleteChannel(env, q.channel.id)
    await processDelivery(q.env, { deliveryId: q.deliveryId, attempt: 0 })
    expect(await delivery(q.deliveryId)).toMatchObject({ status: 'failed', error: '渠道已删除' })

    const q2 = await queuedDelivery()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('dns error for https://hooks.test/secret-token-abc'))
    await setSettings({ maxAttempts: 1 })
    await processDelivery(q2.env, { deliveryId: q2.deliveryId, attempt: 0 })
    expect((await delivery(q2.deliveryId)).error).toBe('network error: dns error for ***')
  })

  it('caps Retry-After and backs off by attempt', () => {
    expect(retryDelayMs(1, null)).toBe(10_000)
    expect(retryDelayMs(99, null)).toBe(3_600_000)
    expect(retryDelayMs(1, 999_999_999)).toBe(3_600_000)
    expect(retryDelayMs(1, 10)).toBe(1000)
  })
})

describe('queue consumer', () => {
  it('acks processed messages and retries on infrastructure errors', async () => {
    mockFetch(() => new Response('ok'))
    const { deliveryId } = await queuedDelivery()
    const batch = createMessageBatch<DeliveryMessage>('yunji-sender-deliveries', [
      { id: 'm1', timestamp: new Date(), attempts: 1, body: { deliveryId, attempt: 0 } },
    ])
    const ctx = createExecutionContext()
    await worker.queue(batch, env, ctx)
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['m1'])

    const bad = createMessageBatch<DeliveryMessage>('yunji-sender-deliveries', [
      { id: 'm2', timestamp: new Date(), attempts: 1, body: { deliveryId: 'x', attempt: 0 } },
    ])
    const brokenEnv = Object.create(env, { DB: { value: { prepare: () => { throw new Error('D1 down') } } } })
    const ctx2 = createExecutionContext()
    await handleDeliveryBatch(bad, brokenEnv)
    const result = await getQueueResult(bad, ctx2)
    expect(result.retryMessages).toEqual([expect.objectContaining({ msgId: 'm2' })])
  })
})

describe('manual retry', () => {
  it('re-opens a failed delivery and replaces its counted failure', async () => {
    await setSettings({ maxAttempts: 1 })
    mockFetch(() => new Response('down', { status: 500 }))
    const q = await queuedDelivery()
    await processDelivery(q.env, { deliveryId: q.deliveryId, attempt: 0 })
    expect(await stats()).toEqual([{ sent: 0, failed: 1, retries: 0 }])

    vi.restoreAllMocks()
    mockFetch(() => new Response('ok'))
    q.sent.length = 0
    expect((await adminCall(`/deliveries/${q.deliveryId}/retry`, { method: 'POST' }, q.env)).status).toBe(202)
    expect(q.sent).toEqual([{ body: { deliveryId: q.deliveryId, attempt: 1 }, delaySeconds: 0 }])
    await processDelivery(q.env, q.sent[0].body)
    expect(await delivery(q.deliveryId)).toMatchObject({ status: 'sent', attempts: 2 })
    expect(await stats()).toEqual([{ sent: 1, failed: 0, retries: 1 }])

    expect((await adminCall(`/deliveries/${q.deliveryId}/retry`, { method: 'POST' }, q.env)).status).toBe(422)
    expect((await adminCall('/deliveries/nope/retry', { method: 'POST' }, q.env)).status).toBe(404)
  })
})

describe('maintenance', () => {
  it('enqueues scheduled deliveries once they fall within the queue horizon', async () => {
    const q = envWithQueue()
    const ch = await webhookChannel()
    const sendAt = Date.now() + 13 * 3600_000
    const r = await sendMessage(q.env, { channels: [ch.id], body: 'x', sendAt }, { source: 'admin', waitUntil: noWait })
    expect(r.deliveries[0].status).toBe('scheduled')

    const early = await runMaintenance(q.env, noWait)
    expect(early.dispatched).toBe(0)
    const report = await runMaintenance(q.env, noWait, sendAt - 3600_000)
    expect(report.dispatched).toBe(1)
    expect(q.sent).toEqual([{ body: { deliveryId: r.deliveries[0].id, attempt: 0 }, delaySeconds: 3600 }])
    expect((await delivery(r.deliveries[0].id)).status).toBe('queued')
  })

  it('sends due deliveries itself in direct mode', async () => {
    await setSettings({ executionMode: 'direct' })
    const calls = mockFetch(() => new Response('ok'))
    const ch = await webhookChannel()
    const sendAt = Date.now() + 60_000
    const r = await sendMessage(env, { channels: [ch.id], body: 'x', sendAt }, { source: 'admin', waitUntil: noWait })
    await runMaintenance(env, noWait)
    expect(calls).toHaveLength(0)
    await runMaintenance(env, noWait, sendAt + 1000)
    expect(calls).toHaveLength(1)
    expect((await delivery(r.deliveries[0].id)).status).toBe('sent')
  })

  it('revives lost queued deliveries and settles expired leases', async () => {
    await setSettings({ maxAttempts: 2 })
    const q = await queuedDelivery()
    const now = Date.now()
    const revived = await runMaintenance(q.env, noWait, now + STALE_QUEUED_MS + 1000)
    expect(revived.revived).toBe(1)
    expect((await delivery(q.deliveryId)).status).toBe('scheduled')

    // A claimed attempt whose Worker died.
    await env.DB.prepare(`UPDATE deliveries SET status = 'sending', attempts = 1, lease_until = ? WHERE id = ?`).bind(now, q.deliveryId).run()
    q.sent.length = 0
    const report = await runMaintenance(q.env, noWait, now + LEASE_MS)
    expect(report.expiredLeases).toBe(1)
    expect(await delivery(q.deliveryId)).toMatchObject({ status: 'queued', attempts: 1, error: '投递中断：尝试超时未完成' })
    expect(q.sent).toEqual([{ body: { deliveryId: q.deliveryId, attempt: 1 }, delaySeconds: BACKOFF_SECONDS[0] }])
  })

  it('purges messages and stats past retention, at most hourly', async () => {
    await setSettings({ retentionDays: 1, statsRetentionDays: 1 })
    const old = Date.now() - 3 * 86_400_000
    await env.DB.prepare(`INSERT INTO messages (id, source, payload, send_at, created_at) VALUES ('old', 'admin', '{}', ?, ?)`).bind(old, old).run()
    await env.DB.prepare(
      `INSERT INTO deliveries (id, message_id, channel_id, channel_type, channel_name, status, next_attempt_at, created_at, updated_at)
       VALUES ('d-old', 'old', 'c', 'webhook', 'c', 'sent', ?, ?, ?)`,
    ).bind(old, old, old).run()
    // Created long ago but scheduled for the future: kept.
    await env.DB.prepare(`INSERT INTO messages (id, source, payload, send_at, created_at) VALUES ('future', 'admin', '{}', ?, ?)`)
      .bind(Date.now() + 86_400_000, old).run()
    await env.DB.prepare(`INSERT INTO delivery_stats_hourly (hour, channel_id, channel_group_slug, sent) VALUES (?, 'c', '', 1)`).bind(old).run()

    const report = await runMaintenance(env, noWait)
    expect(report).toMatchObject({ purgedMessages: 1, purgedStats: 1 })
    expect(await env.DB.prepare('SELECT id FROM messages').all().then((r) => r.results)).toEqual([{ id: 'future' }])
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM deliveries').first()).toEqual({ n: 0 })
    expect((await runMaintenance(env, noWait)).purgedMessages).toBe(0)
  })

  it('keeps old messages with unfinished deliveries, including mixed outcomes', async () => {
    await setSettings({ retentionDays: 1 })
    const now = Date.now()
    const old = now - 3 * 86_400_000
    for (const status of ['scheduled', 'queued', 'sending', 'sent'] as const) {
      await env.DB.prepare(`INSERT INTO messages (id, source, payload, send_at, created_at) VALUES (?, 'admin', '{}', ?, ?)`)
        .bind(status, old, old).run()
      await env.DB.prepare(
        `INSERT INTO deliveries (id, message_id, channel_id, channel_type, channel_name, status,
           next_attempt_at, lease_until, created_at, updated_at)
         VALUES (?, ?, 'c', 'webhook', 'c', ?, ?, ?, ?, ?)`,
      ).bind(status, status, status, now + 86_400_000, now + 3600_000, old, old).run()
    }
    await env.DB.prepare(
      `INSERT INTO deliveries (id, message_id, channel_id, channel_type, channel_name, status, next_attempt_at, created_at, updated_at)
       VALUES ('mixed', 'scheduled', 'c2', 'webhook', 'c2', 'sent', ?, ?, ?)`,
    ).bind(old, old, old).run()

    const report = await runMaintenance(envWithQueue().env, noWait, now)
    expect(report.purgedMessages).toBe(1)
    const { results } = await env.DB.prepare('SELECT id FROM messages ORDER BY id').all()
    expect(results).toEqual([{ id: 'queued' }, { id: 'scheduled' }, { id: 'sending' }])
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM deliveries').first()).toEqual({ n: 4 })
  })

  it('runs from the scheduled handler', async () => {
    const ctx = createExecutionContext()
    await worker.scheduled(createScheduledController({ cron: '* * * * *' }), env, ctx)
    await waitOnExecutionContext(ctx)
  })
})
