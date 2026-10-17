import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { finishDelivery, claimDelivery } from '../src/delivery/repo'
import { adminCall, ADMIN_AUTH, envWithoutQueue, mockFetch, request, webhookChannel } from './helpers'

afterEach(() => vi.restoreAllMocks())

const json = (body: unknown) => ({ body: JSON.stringify(body) })

describe('admin auth', () => {
  it('requires basic auth and blocks cross-site writes', async () => {
    expect((await request('/admin/api/channels')).status).toBe(401)
    expect((await adminCall('/channels')).status).toBe(200)
    const csrf = await request('/admin/api/channels', {
      method: 'POST',
      headers: { ...ADMIN_AUTH, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.test' },
      body: 'a=1',
    })
    expect(csrf.status).toBe(403)
  })

  it('reports settings and queue availability', async () => {
    const me = (await (await adminCall('/me')).json()) as any
    expect(me).toMatchObject({ user: 'admin', authMode: 'basic', executionMode: 'queue', maxAttempts: 5, queueAvailable: true })
  })
})

describe('channels', () => {
  it('encrypts secrets, never returns them, and keeps them when left empty on edit', async () => {
    const res = await adminCall('/channels', {
      method: 'POST',
      ...json({ name: 'tg', type: 'telegram', config: { botToken: '123:super-secret-token', chatId: '42' } }),
    })
    expect(res.status).toBe(201)
    const { channel } = (await res.json()) as any
    expect(channel).toMatchObject({
      type: 'telegram',
      enabled: true,
      config: { chatId: '42', apiBase: 'https://api.telegram.org', silent: false, messageThreadId: '' },
      secretsSet: ['botToken'],
    })
    const list = await (await adminCall('/channels')).text()
    expect(list).not.toContain('super-secret-token')
    const row = await env.DB.prepare('SELECT config, secrets_encrypted FROM channels').first<{ config: string; secrets_encrypted: string }>()
    expect(row!.config + row!.secrets_encrypted).not.toContain('super-secret-token')

    const upd = await adminCall(`/channels/${channel.id}`, {
      method: 'PUT',
      ...json({ name: 'tg2', type: 'telegram', enabled: false, config: { botToken: '', chatId: '43' } }),
    })
    expect(upd.status).toBe(200)
    expect(((await upd.json()) as any).channel).toMatchObject({ name: 'tg2', enabled: false, config: { chatId: '43' }, secretsSet: ['botToken'] })

    const calls = mockFetch(() => Response.json({ ok: true }))
    await adminCall(`/channels/${channel.id}/test`, { method: 'POST' })
    expect(calls[0].url).toContain('/bot123:super-secret-token/')
  })

  it('validates config per type', async () => {
    const res = await adminCall('/channels', {
      method: 'POST',
      ...json({ name: 'x', type: 'webhook', config: { url: 'ftp://x', method: 'GET', headers: '[1]' } }),
    })
    expect(res.status).toBe(422)
    const paths = ((await res.json()) as any).issues.map((i: any) => i.path)
    expect(paths).toEqual(expect.arrayContaining(['config.url', 'config.method']))

    const missing = await adminCall('/channels', { method: 'POST', ...json({ name: 'x', type: 'feishu', config: {} }) })
    expect(((await missing.json()) as any).issues).toEqual([{ path: 'config.webhookUrl', message: 'Webhook 地址不能为空' }])

    const email = await adminCall('/channels', {
      method: 'POST',
      ...json({ name: 'x', type: 'email', config: { apiKey: 're_1', from: 'a@b.c', to: 'ok@x.com, nope' } }),
    })
    expect(((await email.json()) as any).issues).toEqual([{ path: 'config.to', message: '无效的邮箱地址：nope' }])
  })

  it('refuses to change the type', async () => {
    const ch = await webhookChannel()
    const res = await adminCall(`/channels/${ch.id}`, { method: 'PUT', ...json({ name: 'x', type: 'slack', config: {} }) })
    expect(res.status).toBe(422)
  })

  it('tests a channel synchronously and redacts secrets from errors', async () => {
    const ch = await webhookChannel('hook', 'https://hooks.test/secret-path-123')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect failed: https://hooks.test/secret-path-123'))
    const res = (await (await adminCall(`/channels/${ch.id}/test`, { method: 'POST' })).json()) as any
    expect(res.result).toMatchObject({ ok: false, httpStatus: null })
    expect(res.result.error).toBe('network error: connect failed: ***')
  })
})

describe('topics', () => {
  it('binds channels, enforces unique slugs, and drops bindings with the channel', async () => {
    const a = await webhookChannel('a')
    const b = await webhookChannel('b')
    const res = await adminCall('/topics', { method: 'POST', ...json({ slug: 'ops-alert', name: '运维告警', channelIds: [a.id, b.id, a.id] }) })
    expect(res.status).toBe(201)
    const { topic } = (await res.json()) as any
    expect(topic.channelIds.sort()).toEqual([a.id, b.id].sort())

    const dup = await adminCall('/topics', { method: 'POST', ...json({ slug: 'ops-alert', name: 'x' }) })
    expect(((await dup.json()) as any).issues[0].path).toBe('slug')
    const bad = await adminCall('/topics', { method: 'POST', ...json({ slug: 'Bad Slug', name: 'x' }) })
    expect(bad.status).toBe(422)
    const unknown = await adminCall('/topics', { method: 'POST', ...json({ slug: 'x', name: 'x', channelIds: ['nope'] }) })
    expect(((await unknown.json()) as any).issues[0].path).toBe('channelIds')

    await adminCall(`/channels/${a.id}`, { method: 'DELETE' })
    const after = (await (await adminCall(`/topics/${topic.id}`)).json()) as any
    expect(after.topic.channelIds).toEqual([b.id])
    const chB = (await (await adminCall(`/channels/${b.id}`)).json()) as any
    expect(chB.channel.topicSlugs).toEqual(['ops-alert'])
  })
})

describe('api keys', () => {
  it('shows the key once, stores only a hash, and revokes', async () => {
    const res = await adminCall('/keys', { method: 'POST', ...json({ name: 'ci', topics: ['ops'] }) })
    const { key, info } = (await res.json()) as any
    expect(key).toMatch(/^cfs_/)
    expect(info).toMatchObject({ name: 'ci', topics: ['ops'], prefix: key.slice(0, 10), revokedAt: null })
    expect(await (await adminCall('/keys')).text()).not.toContain(key)
    expect((await adminCall(`/keys/${info.id}/revoke`, { method: 'POST' })).status).toBe(204)
    const list = (await (await adminCall('/keys')).json()) as any
    expect(list.keys[0].revokedAt).not.toBeNull()
  })
})

describe('settings', () => {
  it('validates and saves runtime settings', async () => {
    const put = await adminCall('/settings/runtime', {
      method: 'PUT',
      ...json({ executionMode: 'direct', maxAttempts: 3, retentionDays: 7, statsRetentionDays: 30 }),
    })
    expect(put.status).toBe(200)
    expect(((await (await adminCall('/me')).json()) as any).maxAttempts).toBe(3)
    const bad = await adminCall('/settings/runtime', { method: 'PUT', ...json({ executionMode: 'direct', maxAttempts: 0, retentionDays: 7, statsRetentionDays: 30 }) })
    expect(bad.status).toBe(422)
  })

  it('refuses queue mode without the binding', async () => {
    const res = await adminCall(
      '/settings/runtime',
      { method: 'PUT', ...json({ executionMode: 'queue', maxAttempts: 3, retentionDays: 7, statsRetentionDays: 30 }) },
      envWithoutQueue(),
    )
    expect(((await res.json()) as any).issues[0].path).toBe('executionMode')
  })
})

describe('stats', () => {
  it('aggregates outcomes by channel and topic', async () => {
    const ch = await webhookChannel('hook')
    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO messages (id, topic_slug, source, payload, send_at, created_at) VALUES ('m1', 'ops', 'admin', '{}', ?, ?)`,
    ).bind(now - 5000, now - 5000).run()
    await env.DB.prepare(
      `INSERT INTO deliveries (id, message_id, channel_id, channel_type, channel_name, topic_slug, status, next_attempt_at, created_at, updated_at)
       VALUES ('d1', 'm1', ?, 'webhook', 'hook', 'ops', 'queued', ?, ?, ?), ('d2', 'm1', ?, 'webhook', 'hook', 'ops', 'queued', ?, ?, ?)`,
    ).bind(ch.id, now, now, now, ch.id, now, now, now).run()
    for (const [id, status] of [['d1', 'sent'], ['d2', 'failed']] as const) {
      const d = (await claimDelivery(env.DB, id, 0, now))!
      await finishDelivery(env.DB, d, status, { durationMs: 5, httpStatus: 200, responseBody: null, error: null }, now)
    }
    const stats = (await (await adminCall('/stats?range=24h&tz=Asia/Shanghai')).json()) as any
    expect(stats.summary).toMatchObject({ total: 2, sent: 1, failed: 1, successRate: 0.5, retries: 0, latencyAvg: 5000 })
    expect(stats.series).toHaveLength(24)
    expect(stats.byChannel).toEqual([expect.objectContaining({ key: ch.id, label: 'hook', type: 'webhook', total: 2 })])
    expect(stats.byTopic).toEqual([expect.objectContaining({ key: 'ops', total: 2, failed: 1 })])
  })
})
