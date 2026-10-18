import { expect, test } from '@playwright/test'
import type { SendResult, RuntimeSettings, StatsOverview, MessageDetail } from '../src/shared/types'
import { baseURL, call, createChannel, createKey, providerRecords, providerURL, seed, waitMessage } from './helpers'

test('concurrent HTTP admission preserves idempotency and caller quotas', async () => {
  const channel = await createChannel('Concurrent admission')
  const key = await createKey()
  const { settings } = await call<{ settings: RuntimeSettings }>('/admin/api/settings/runtime')
  await call('/admin/api/settings/runtime', {
    method: 'PUT', data: { ...settings, perKeyDailyDeliveryLimit: 2, perKeyMinuteLimit: 2 },
  })
  const send = (id: string) => fetch(`${baseURL}/api/send`, {
    method: 'POST', signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json',
      'idempotency-key': id, 'cf-connecting-ip': '192.0.2.180' },
    body: JSON.stringify({ channels: [channel.id], body: 'Concurrent fixture', sendAt: Date.now() + 60_000 }),
  })
  const accepted = new Set<string>()
  try {
    const responses = await Promise.all(Array.from({ length: 8 }, () => send('same-event')))
    expect(responses.filter(r => r.status === 202)).toHaveLength(1)
    expect(responses.filter(r => r.status === 200)).toHaveLength(7)
    for (const response of responses) accepted.add((await response.json() as SendResult).messageId)
    expect(accepted.size).toBe(1)

    const competing = await Promise.all(Array.from({ length: 6 }, (_, i) => send(`distinct-${i}`)))
    expect(competing.filter(r => r.status === 202)).toHaveLength(1)
    expect(competing.filter(r => r.status === 429)).toHaveLength(5)
    for (const response of competing) {
      if (response.status === 202) accepted.add((await response.json() as SendResult).messageId)
      else {
        expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
        expect(await response.json()).toMatchObject({ error: 'safety_limit' })
      }
    }
    const duplicate = await send('same-event')
    expect(duplicate.status).toBe(200)
    expect(await duplicate.json()).toMatchObject({ duplicate: true })
    for (const id of accepted) {
      expect(await call(`/api/messages/${id}/cancel`, { method: 'POST', token: key.key })).toEqual({ canceled: 1 })
    }
    expect((await providerRecords()).filter(r => accepted.has(String(r.data.id)))).toHaveLength(0)
  } finally {
    await call('/admin/api/settings/runtime', { method: 'PUT', data: settings })
  }
})

test('pause blocks due work and test sends, then cron resumes exactly once', async () => {
  const channel = await createChannel('Pause and resume')
  const key = await createKey()
  const { settings } = await call<{ settings: RuntimeSettings }>('/admin/api/settings/runtime')
  const direct = { ...settings, executionMode: 'direct' }
  await call('/admin/api/settings/runtime', { method: 'PUT', data: direct })
  try {
    const sendAt = Date.now() + 2000
    const message = await call<SendResult>('/api/send', {
      method: 'POST', token: key.key, status: 202,
      data: { channels: [channel.id], body: 'Resume fixture', sendAt },
    })
    await call('/admin/api/settings/runtime', { method: 'PUT', data: { ...direct, sendingPaused: true } })
    expect(await call('/api/send', { method: 'POST', token: key.key, status: 503,
      data: { channels: [channel.id], body: 'Blocked fixture' } })).toMatchObject({ error: 'safety_limit', reason: 'paused' })
    expect(await call(`/admin/api/channels/${channel.id}/test`, { method: 'POST', status: 503 }))
      .toMatchObject({ error: 'safety_limit', reason: 'paused' })
    await expect.poll(() => Date.now(), { timeout: 5000 }).toBeGreaterThan(sendAt)
    const cron = () => fetch(`${baseURL}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`, { signal: AbortSignal.timeout(10_000) })
    expect((await cron()).ok).toBe(true)
    const pending = await call<{ message: MessageDetail }>(`/api/messages/${message.messageId}`, { token: key.key })
    expect(pending.message.deliveries[0]).toMatchObject({ status: 'scheduled', attempts: 0 })
    expect((await providerRecords()).filter(r => r.data.id === message.messageId)).toHaveLength(0)

    await call('/admin/api/settings/runtime', { method: 'PUT', data: direct })
    expect((await cron()).ok).toBe(true)
    expect((await waitMessage(message.messageId, 'sent', key.key)).deliveries[0].attempts).toBe(1)
    expect((await cron()).ok).toBe(true)
    expect((await providerRecords()).filter(r => r.data.id === message.messageId)).toHaveLength(1)
  } finally {
    await call('/admin/api/settings/runtime', { method: 'PUT', data: settings })
  }
})

test('queue and direct delivery lifecycle, scopes, idempotency, cancellation and retries', async () => {
  await call('/admin/api/channels', { token: null, status: 401 })
  await call('/api/send', { method: 'POST', data: {}, token: null, status: 401 })
  const fixture = await seed()
  const { key, channel, channelGroup } = fixture
  const flaky = await createChannel('Retry once', '/fail-once')
  await call(`/admin/api/channel-groups/${channelGroup.id}`, {
    method: 'PUT', data: { slug: channelGroup.slug, name: channelGroup.name, channelIds: [channel.id, flaky.id] },
  })
  await call('/api/send', { method: 'POST', token: key.key, status: 403, data: { channels: [channel.id], body: 'forbidden' } })
  const other = await createKey()
  await call(`/api/messages/${fixture.messageId}`, { token: other.key, status: 404 })

  const data = { channelGroup: channelGroup.slug, body: `Queue ${channelGroup.slug}` }
  const sent = await call<SendResult>('/api/send', {
    method: 'POST', token: key.key, status: 202, data, headers: { 'idempotency-key': 'queue-once' },
  })
  const duplicate = await call<SendResult>('/api/send', {
    method: 'POST', token: key.key, data, headers: { 'idempotency-key': 'queue-once' },
  })
  expect(duplicate).toMatchObject({ messageId: sent.messageId, duplicate: true })
  const canceled = await call<SendResult>('/api/send', {
    method: 'POST', token: key.key, status: 202,
    data: { channelGroup: channelGroup.slug, body: 'Canceled fixture', sendAt: Date.now() + 5000 },
  })
  expect(await call(`/api/messages/${canceled.messageId}/cancel`, { method: 'POST', token: key.key })).toEqual({ canceled: 2 })
  const delivered = await waitMessage(sent.messageId, 'sent', key.key)
  expect(delivered.counts.sent).toBe(2)
  expect(delivered.deliveries.find((d) => d.channelId === flaky.id)?.attempts).toBe(2)
  const records = await providerRecords()
  expect(records.filter((r) => r.data.id === sent.messageId && r.path === '/ok')).toHaveLength(1)
  expect(records.filter((r) => r.data.id === sent.messageId && r.path === '/fail-once')).toHaveLength(2)
  expect(records.filter((r) => r.data.id === canceled.messageId)).toHaveLength(0)

  const { settings } = await call<{ settings: RuntimeSettings }>('/admin/api/settings/runtime')
  await call('/admin/api/settings/runtime', { method: 'PUT', data: { ...settings, executionMode: 'direct' } })
  try {
    const bad = await createChannel('Permanent failure', '/reject')
    const failed = await call<SendResult>('/admin/api/send', {
      method: 'POST', status: 202, data: { channels: [bad.id], body: 'Manual retry' },
    })
    await waitMessage(failed.messageId, 'failed')
    await call(`/admin/api/channels/${bad.id}`, {
      method: 'PUT', data: { name: bad.name, type: 'webhook', config: { url: `${providerURL}/ok` } },
    })
    await call(`/admin/api/deliveries/${failed.deliveries[0].id}/retry`, { method: 'POST', status: 202 })
    expect((await waitMessage(failed.messageId, 'sent')).deliveries[0].attempts).toBe(2)

    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push((await createChannel(`Cron fixture ${i}`)).id)
    const backlog = await call<SendResult>('/admin/api/send', {
      method: 'POST', status: 202, data: { channels: ids, body: 'Cron backlog' },
    })
    const cron = await fetch(`${baseURL}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`)
    expect(cron.ok).toBe(true)
    expect((await waitMessage(backlog.messageId, 'sent')).counts.sent).toBe(5)
  } finally {
    await call('/admin/api/settings/runtime', { method: 'PUT', data: settings })
  }
  const stats = await call<StatsOverview>('/admin/api/stats?range=24h&tz=Asia%2FTaipei')
  expect(stats.byChannelGroup.find((g) => g.key === channelGroup.slug)).toMatchObject({ sent: 3, failed: 0 })
  await call(`/admin/api/keys/${key.info.id}/revoke`, { method: 'POST', status: 204 })
  await call('/api/send', { method: 'POST', token: key.key, status: 401, data })
})

test('production HTTP boundaries and Bark Unicode recipient isolation', async () => {
  const fixture = await seed()
  await call('/api/send', {
    method: 'POST', token: fixture.key.key, status: 422,
    data: { channelGroup: fixture.channelGroup.slug, body: '中'.repeat(5462) },
  })
  await call('/api/send', { method: 'POST', token: fixture.key.key, status: 413, data: { body: 'x'.repeat(256 * 1024) } })
  let chunks = 0
  const streamed = await fetch(`${baseURL}/api/send`, {
    method: 'POST', headers: { authorization: `Bearer ${fixture.key.key}`, 'content-type': 'application/json' },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024).fill(32))
        if (++chunks === 6) controller.close()
      },
    }),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
  expect(streamed.status).toBe(413)
  expect(await streamed.json()).toMatchObject({ error: 'payload_too_large', maxBytes: 262144 })
  const { channel } = await call<{ channel: { id: string } }>('/admin/api/channels', {
    method: 'POST', status: 201,
    data: { name: 'Bark routing', type: 'bark', config: { serverUrl: providerURL, deviceKey: 'saved-device' } },
  })
  const key = await createKey()
  const message = await call<SendResult>('/api/send', {
    method: 'POST', status: 202, token: key.key,
    data: { channels: [channel.id], body: 'test', raw: { bark: { body: 'test', 'devİce_key': 'other-device', device_keys: ['other-device'] } } },
  })
  await waitMessage(message.messageId, 'sent', key.key)
  expect((await providerRecords()).filter((r) => r.path === '/push').at(-1)?.data).toEqual({ body: 'test', device_key: 'saved-device' })
})
