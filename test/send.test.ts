import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { updateChannel } from '../src/domain/channels'
import { QUEUE_MAX_DELAY_S } from '../src/delivery/mode'
import { SenderRpc } from '../src/rpc'
import { adminCall, apiCall, apiKey, envWithQueue, mockFetch, setSettings, topicWith, webhookChannel } from './helpers'

afterEach(() => vi.restoreAllMocks())

const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', body: JSON.stringify(body), headers })

async function statusOf(deliveryId: string) {
  return (await env.DB.prepare('SELECT status, next_attempt_at FROM deliveries WHERE id = ?').bind(deliveryId).first<{
    status: string
    next_attempt_at: number
  }>())!
}

describe('POST /api/send auth', () => {
  it('rejects missing, unknown and revoked keys', async () => {
    const q = envWithQueue()
    expect((await apiCall('nope', '/send', post({}), q.env)).status).toBe(401)
    const key = await apiKey()
    await env.DB.prepare('UPDATE api_keys SET revoked_at = 1').run()
    expect((await apiCall(key, '/send', post({}), q.env)).status).toBe(401)
  })

  it('limits restricted keys to their topics', async () => {
    const q = envWithQueue()
    const ch = await webhookChannel()
    await topicWith('ops', [ch.id])
    await topicWith('biz', [ch.id])
    const key = await apiKey(['ops'])
    expect((await apiCall(key, '/send', post({ topic: 'ops', body: 'x' }), q.env)).status).toBe(202)
    expect((await apiCall(key, '/send', post({ topic: 'biz', body: 'x' }), q.env)).status).toBe(403)
    expect((await apiCall(key, '/send', post({ channels: [ch.id], body: 'x' }), q.env)).status).toBe(403)
  })
})

describe('fan-out', () => {
  it('creates one delivery per enabled channel and enqueues them', async () => {
    const q = envWithQueue()
    const a = await webhookChannel('a')
    const b = await webhookChannel('b')
    const off = await webhookChannel('off')
    await updateChannel(env, off.id, { name: 'off', type: 'webhook', enabled: false, config: {} })
    await topicWith('ops', [a.id, b.id, off.id])
    const key = await apiKey()
    const res = await apiCall(key, '/send', post({ topic: 'ops', channels: [a.id], title: '部署完成', body: 'v1.2' }), q.env)
    expect(res.status).toBe(202)
    const result = (await res.json()) as any
    expect(result.duplicate).toBe(false)
    expect(result.deliveries.map((d: any) => d.channelName).sort()).toEqual(['a', 'b'])
    expect(result.deliveries.every((d: any) => d.status === 'queued')).toBe(true)
    expect(q.sent.map((s) => s.body).sort((x, y) => x.deliveryId.localeCompare(y.deliveryId))).toEqual(
      result.deliveries.map((d: any) => ({ deliveryId: d.id, attempt: 0 })).sort((x: any, y: any) => x.deliveryId.localeCompare(y.deliveryId)),
    )
    expect(q.sent.every((s) => s.delaySeconds === 0)).toBe(true)

    const detail = (await (await apiCall(key, `/messages/${result.messageId}`)).json()) as any
    expect(detail.message).toMatchObject({ topicSlug: 'ops', source: 'api', title: '部署完成', status: 'pending' })
    expect(detail.message.content).toMatchObject({ body: 'v1.2', format: 'text', level: 'info', url: null, tags: [] })
  })

  it('rejects unknown topics, unknown or disabled channels, and empty topics', async () => {
    const q = envWithQueue()
    const key = await apiKey()
    const off = await webhookChannel('off')
    await updateChannel(env, off.id, { name: 'off', type: 'webhook', enabled: false, config: {} })
    await topicWith('empty', [off.id])
    const issue = async (body: unknown) => ((await (await apiCall(key, '/send', post(body), q.env)).json()) as any).issues[0]
    expect(await issue({ topic: 'nope', body: 'x' })).toMatchObject({ path: 'topic' })
    expect(await issue({ channels: ['nope'], body: 'x' })).toMatchObject({ path: 'channels' })
    expect(await issue({ channels: [off.id], body: 'x' })).toMatchObject({ path: 'channels', message: expect.stringContaining('已停用') })
    expect(await issue({ topic: 'empty', body: 'x' })).toMatchObject({ path: 'topic', message: expect.stringContaining('没有可用的渠道') })
    expect(await issue({ topic: 'empty' })).toMatchObject({ path: 'body' })
    expect(await issue({ body: 'x' })).toMatchObject({ path: 'topic' })
    expect(await issue({ topic: 'empty', body: 'x', url: 'javascript:1' })).toMatchObject({ path: 'url' })
    expect(q.sent).toEqual([])
  })
})

describe('idempotency', () => {
  it('returns the original message for a repeated key, scoped per API key', async () => {
    const q = envWithQueue()
    const ch = await webhookChannel()
    const key1 = await apiKey()
    const key2 = await apiKey()
    const body = { channels: [ch.id], body: 'once' }
    const first = (await (await apiCall(key1, '/send', post(body, { 'idempotency-key': 'k-1' }), q.env)).json()) as any
    const again = await apiCall(key1, '/send', post(body, { 'idempotency-key': 'k-1' }), q.env)
    expect(again.status).toBe(200)
    expect((await again.json()) as any).toMatchObject({ messageId: first.messageId, duplicate: true })
    const other = (await (await apiCall(key2, '/send', post(body, { 'idempotency-key': 'k-1' }), q.env)).json()) as any
    expect(other.messageId).not.toBe(first.messageId)
    expect(q.sent).toHaveLength(2)
  })
})

describe('sendAt', () => {
  it('delays within 12 h on the queue and keeps later messages in D1', async () => {
    const q = envWithQueue()
    const ch = await webhookChannel()
    const key = await apiKey()
    const soon = Date.now() + 3_600_000
    const r1 = (await (await apiCall(key, '/send', post({ channels: [ch.id], body: 'x', sendAt: new Date(soon).toISOString() }), q.env)).json()) as any
    expect(r1.deliveries[0].status).toBe('queued')
    expect(q.sent[0].delaySeconds).toBeGreaterThan(3590)
    expect(q.sent[0].delaySeconds).toBeLessThanOrEqual(3600)

    const later = Date.now() + (QUEUE_MAX_DELAY_S + 3600) * 1000
    const r2 = (await (await apiCall(key, '/send', post({ channels: [ch.id], body: 'x', sendAt: later }), q.env)).json()) as any
    expect(r2.deliveries[0].status).toBe('scheduled')
    expect(q.sent).toHaveLength(1)
    const detail = (await (await apiCall(key, `/messages/${r2.messageId}`)).json()) as any
    expect(detail.message.status).toBe('scheduled')

    const bad = await apiCall(key, '/send', post({ channels: [ch.id], body: 'x', sendAt: 'tomorrow' }), q.env)
    expect(((await bad.json()) as any).issues[0].path).toBe('sendAt')
  })

  it('cancels deliveries that have not started', async () => {
    const q = envWithQueue()
    const ch = await webhookChannel()
    const key = await apiKey()
    const r = (await (await apiCall(key, '/send', post({ channels: [ch.id], body: 'x', sendAt: Date.now() + 60_000 }), q.env)).json()) as any
    const res = await apiCall(key, `/messages/${r.messageId}/cancel`, { method: 'POST' })
    expect(await res.json()).toEqual({ canceled: 1 })
    expect((await statusOf(r.deliveries[0].id)).status).toBe('canceled')
    // Other keys cannot see it.
    expect((await apiCall(await apiKey(), `/messages/${r.messageId}`)).status).toBe(404)
  })
})

describe('direct mode', () => {
  it('sends due deliveries in waitUntil and keeps future ones for the cron', async () => {
    await setSettings({ executionMode: 'direct' })
    const calls = mockFetch(() => new Response('ok'))
    const ch = await webhookChannel()
    const key = await apiKey()
    const r = (await (await apiCall(key, '/send', post({ channels: [ch.id], title: 't', body: 'now' }))).json()) as any
    expect(calls).toHaveLength(1)
    expect(calls[0].json()).toMatchObject({ id: r.messageId, title: 't', body: 'now' })
    expect((await statusOf(r.deliveries[0].id)).status).toBe('sent')

    const later = (await (await apiCall(key, '/send', post({ channels: [ch.id], body: 'later', sendAt: Date.now() + 60_000 }))).json()) as any
    expect(later.deliveries[0].status).toBe('scheduled')
    expect(calls).toHaveLength(1)
  })

  it('falls back to direct when queue mode is set but the binding is missing', async () => {
    const calls = mockFetch(() => new Response('ok'))
    const ch = await webhookChannel()
    const e = Object.create(env, { DELIVERY_QUEUE: { value: undefined } }) as CloudflareBindings
    const res = await adminCall('/send', post({ channels: [ch.id], body: 'x' }), e)
    expect(res.status).toBe(202)
    expect(calls).toHaveLength(1)
  })
})

describe('queue failures', () => {
  it('leaves deliveries to the cron when enqueueing fails', async () => {
    const q = envWithQueue({ fail: true })
    const ch = await webhookChannel()
    const r = (await (await adminCall('/send', post({ channels: [ch.id], body: 'x' }), q.env)).json()) as any
    expect(r.deliveries[0].status).toBe('scheduled')
  })
})

describe('RPC entrypoint', () => {
  it('sends without an API key and honors idempotency', async () => {
    const q = envWithQueue()
    const ch = await webhookChannel()
    await topicWith('ops', [ch.id])
    const ctx = createExecutionContext()
    const rpc = new SenderRpc(ctx, q.env)
    const r1 = await rpc.send({ topic: 'ops', title: '任务失败', body: 'boom', level: 'error' }, { idempotencyKey: 'run-1' })
    const r2 = await rpc.send({ topic: 'ops', title: '任务失败', body: 'boom', level: 'error' }, { idempotencyKey: 'run-1' })
    await waitOnExecutionContext(ctx)
    expect(r1.deliveries).toHaveLength(1)
    expect(r2).toMatchObject({ messageId: r1.messageId, duplicate: true })
    const row = await env.DB.prepare('SELECT source, idem FROM messages').first()
    expect(row).toEqual({ source: 'rpc', idem: 'rpc:run-1' })
    await expect(rpc.send({ topic: 'nope', body: 'x' })).rejects.toThrow(/topic/)
  })
})
