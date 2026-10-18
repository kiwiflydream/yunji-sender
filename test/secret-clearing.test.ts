import { env } from 'cloudflare:workers'
import { afterEach, expect, it, vi } from 'vitest'
import { loadChannel } from '../src/domain/channels'
import { adminCall, mockFetch } from './helpers'

afterEach(() => vi.restoreAllMocks())

const put = (data: unknown) => ({ method: 'PUT', body: JSON.stringify(data) })

it.each([
  ['pushplus', { token: 'dummy-token', to: 'old-recipient' }, ['to']],
  ['webhook', { url: 'https://hooks.test/notify', headers: '{"Authorization":"Bearer dummy"}', signingSecret: 'dummy-signature' }, ['headers', 'signingSecret']],
  ['feishu', { webhookUrl: 'https://hooks.test/feishu', signSecret: 'dummy-signature' }, ['signSecret']],
  ['dingtalk', { webhookUrl: 'https://hooks.test/dingtalk', signSecret: 'dummy-signature' }, ['signSecret']],
] as const)('explicitly clears optional %s secrets, while blanks still preserve them', async (type, config, fields) => {
  const created = await adminCall('/channels', { method: 'POST', body: JSON.stringify({ name: 'dummy', type, config }) })
  expect(created.status).toBe(201)
  const { channel } = await created.json() as any
  const blank = Object.fromEntries(fields.map((field) => [field, '']))
  const unchanged = await adminCall(`/channels/${channel.id}`, put({ name: 'dummy', type, config: blank }))
  expect(unchanged.status).toBe(200)
  for (const field of fields) expect((await loadChannel(env, channel.id))!.config[field]).toBe(config[field as keyof typeof config])

  const cleared = await adminCall(`/channels/${channel.id}`, put({ name: 'dummy', type, config: blank, clearSecrets: fields }))
  expect(cleared.status).toBe(200)
  const saved = (await cleared.json() as any).channel
  for (const field of fields) {
    expect(saved.secretsSet).not.toContain(field)
    expect((await loadChannel(env, channel.id))!.config[field]).toBe('')
  }
  const calls = mockFetch(() => Response.json({ code: 200, errcode: 0 }))
  await adminCall(`/channels/${channel.id}/test`, { method: 'POST' })
  expect(calls).toHaveLength(1)
  if (type === 'pushplus') expect(calls[0].json()).not.toHaveProperty('to')
  if (type === 'webhook') {
    expect(calls[0].headers.has('authorization')).toBe(false)
    expect(calls[0].headers.has('x-sender-signature')).toBe(false)
  }
  if (type === 'feishu') expect(calls[0].json()).not.toHaveProperty('sign')
  if (type === 'dingtalk') expect(new URL(calls[0].url).searchParams.has('sign')).toBe(false)
})

it.each(['url', 'method', 'unknown'])('rejects clearing required, public or unknown field %s without changing the channel', async (field) => {
  const created = await adminCall('/channels', { method: 'POST', body: JSON.stringify({ name: 'original', type: 'webhook', config: { url: 'https://hooks.test/original' } }) })
  const { channel } = await created.json() as any
  const response = await adminCall(`/channels/${channel.id}`, put({ name: 'changed', type: 'webhook', clearSecrets: [field] }))
  expect(response.status).toBe(422)
  expect((await loadChannel(env, channel.id))!.name).toBe('original')
})

it('rejects conflicting replacement and clear requests atomically', async () => {
  const created = await adminCall('/channels', { method: 'POST', body: JSON.stringify({ name: 'original', type: 'pushplus', config: { token: 'dummy-token', to: 'original-recipient' } }) })
  const { channel } = await created.json() as any
  const response = await adminCall(`/channels/${channel.id}`, put({ name: 'changed', type: 'pushplus', config: { to: 'new-recipient' }, clearSecrets: ['to'] }))
  expect(response.status).toBe(422)
  expect(await loadChannel(env, channel.id)).toMatchObject({ name: 'original', config: { to: 'original-recipient' } })
})
