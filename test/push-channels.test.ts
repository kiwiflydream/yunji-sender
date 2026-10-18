import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getProvider } from '../src/channels/registry'
import type { OutboundMessage } from '../src/channels/types'
import { processDelivery } from '../src/delivery/process'
import { createChannel } from '../src/domain/channels'
import { getMessage, sendMessage } from '../src/domain/messages'
import { adminCall, envWithQueue, mockFetch, channelGroupWith } from './helpers'

afterEach(() => vi.restoreAllMocks())

const message = (overrides: Partial<OutboundMessage> = {}): OutboundMessage => ({
  deliveryId: 'd1', messageId: 'm1', channelGroup: 'ops', createdAt: Date.now(),
  title: '磁盘告警', body: '使用率 **95%**', format: 'markdown', level: 'error',
  url: 'https://status.test', tags: ['prod', 'disk'], raw: null, ...overrides,
})

const channels: {
  type: 'pushplus' | 'serverchan'
  config: Record<string, string>
  secretField: string
  success: Record<string, unknown>
}[] = [
  { type: 'pushplus', config: { token: 'pushplus-secret-token' }, secretField: 'token', success: { code: 200, data: 'receipt' } },
  { type: 'serverchan', config: { sendKey: 'SCT123secretkey' }, secretField: 'sendKey', success: { code: 0, data: {} } },
]

describe('PushPlus', () => {
  it('renders Markdown, title, link and tags with configured routing', async () => {
    const calls = mockFetch(() => Response.json({ code: 200, data: 'receipt' }))
    const outcome = await getProvider('pushplus').send({ token: 'token', topic: 'group', channel: 'cp', option: 'ops', to: 'uid' }, message())
    expect(outcome.ok).toBe(true)
    expect(calls[0].url).toBe('https://www.pushplus.plus/send')
    expect(calls[0].json()).toEqual({
      title: '🚨 磁盘告警', content: '使用率 **95%**\n\nhttps://status.test\n#prod #disk',
      template: 'markdown', token: 'token', topic: 'group', channel: 'cp', option: 'ops', to: 'uid',
    })
  })

  it('supports title-only messages as text and defaults to WeChat', async () => {
    const calls = mockFetch(() => Response.json({ code: 200 }))
    await getProvider('pushplus').send({ token: 'token' }, message({ body: '', format: 'text', url: null, tags: [] }))
    expect(calls[0].json()).toMatchObject({ content: '磁盘告警', template: 'txt', channel: 'wechat' })
  })

  it('allows raw content while protecting all routing fields, including empty optional fields', async () => {
    const calls = mockFetch(() => Response.json({ code: 200 }))
    await getProvider('pushplus').send({ token: 'saved' }, message({ raw: {
      content: 'custom', template: 'html', token: 'other', channel: 'sms', topic: 'other', option: 'other', to: 'other',
    } }))
    expect(calls[0].json()).toEqual({ content: 'custom', template: 'html', token: 'saved', channel: 'wechat' })
  })

  it.each([[500, true], [900, false], [903, false], [888, false], [999, false]])(
    'classifies business code %s with retryable=%s', async (code, retryable) => {
      mockFetch(() => Response.json({ code, msg: 'error' }))
      expect(await getProvider('pushplus').send({ token: 'token' }, message()))
        .toMatchObject({ ok: false, retryable, error: `PushPlus 返回 ${code}: error` })
    },
  )
})

describe('Server酱', () => {
  it.each([
    ['SCT123secretkey', 'https://sctapi.ftqq.com/SCT123secretkey.send'],
    ['sctp123tsecretkey', 'https://123.push.ft07.com/send/sctp123tsecretkey.send'],
  ])('selects the endpoint for %s and sends Markdown', async (sendKey, url) => {
    const calls = mockFetch(() => Response.json({ code: 0 }))
    expect((await getProvider('serverchan').send({ sendKey }, message())).ok).toBe(true)
    expect(calls[0].url).toBe(url)
    expect(calls[0].json()).toMatchObject({ title: '🚨 磁盘告警', desp: '使用率 **95%**\n\nhttps://status.test\n#prod #disk' })
    expect(calls[0].json().tags).toBe(sendKey.startsWith('sctp') ? 'prod|disk' : undefined)
  })

  it('provides a single-line title for body-only messages and truncates without splitting emoji', async () => {
    const calls = mockFetch(() => Response.json({ code: 0 }))
    await getProvider('serverchan').send({ sendKey: 'SCTkey' }, message({ title: '', body: '**完成**\n第二行' }))
    expect(calls[0].json().title).toBe('完成')
    await getProvider('serverchan').send({ sendKey: 'SCTkey' }, message({ title: '🚨'.repeat(40) + '\nnext' }))
    const title = calls[1].json().title
    expect(title.length).toBeLessThanOrEqual(32)
    expect(title).not.toMatch(/[\r\n]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u)
  })

  it('supports raw content without changing recipients', async () => {
    const calls = mockFetch(() => Response.json({ code: 0 }))
    await getProvider('serverchan').send({ sendKey: 'SCTkey' }, message({ raw: { title: 'raw', desp: 'custom', short: 'brief', channel: 'other', openid: 'other' } }))
    expect(calls[0].url).toBe('https://sctapi.ftqq.com/SCTkey.send')
    expect(calls[0].json()).toEqual({ title: 'raw', desp: 'custom', short: 'brief' })
  })

  it('reports rejected requests as permanent failures', async () => {
    mockFetch(() => Response.json({ code: 40001, message: 'invalid sendkey' }))
    expect(await getProvider('serverchan').send({ sendKey: 'SCTkey' }, message()))
      .toMatchObject({ ok: false, retryable: false, error: 'Server酱返回 40001: invalid sendkey' })
  })
})

describe.each(channels)('$type integration', ({ type, config, secretField, success }) => {
  it('encrypts credentials, preserves them on edit and redacts test failures', async () => {
    const secret = config[secretField]!
    const created = await adminCall('/channels', { method: 'POST', body: JSON.stringify({ name: type, type, config }) })
    expect(created.status).toBe(201)
    const { channel } = await created.json() as any
    expect(channel.secretsSet).toContain(secretField)
    expect(JSON.stringify(channel)).not.toContain(secret)
    const row = await env.DB.prepare('SELECT config, secrets_encrypted FROM channels WHERE id = ?').bind(channel.id).first()
    expect(JSON.stringify(row)).not.toContain(secret)

    const updated = await adminCall(`/channels/${channel.id}`, {
      method: 'PUT', body: JSON.stringify({ name: type, type, config: { [secretField]: '' } }),
    })
    expect(updated.status).toBe(200)
    const calls = mockFetch(() => Response.json(success))
    expect((await (await adminCall(`/channels/${channel.id}/test`, { method: 'POST' })).json() as any).result.ok).toBe(true)
    expect(type === 'pushplus' ? calls[0].json().token : calls[0].url).toContain(secret)

    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(`network failed for ${secret}`))
    const failed = await (await adminCall(`/channels/${channel.id}/test`, { method: 'POST' })).json() as any
    expect(failed.result).toMatchObject({ ok: false, error: 'network error: network failed for ***' })
  })

  it('requires its credential and rejects malformed success responses', async () => {
    const res = await adminCall('/channels', { method: 'POST', body: JSON.stringify({ name: type, type, config: {} }) })
    expect(res.status).toBe(422)
    expect((await res.json() as any).issues[0].path).toBe(`config.${secretField}`)
    mockFetch(() => new Response('<html>proxy error</html>'))
    expect(await getProvider(type).send(config, message())).toMatchObject({ ok: false, retryable: true })
  })

  it('uses the shared HTTP retry policy for throttling and transport failure', async () => {
    mockFetch(() => new Response('slow down', { status: 429, headers: { 'retry-after': '60' } }))
    expect(await getProvider(type).send(config, message())).toMatchObject({ ok: false, retryable: true, retryAfterMs: 60_000 })
    vi.restoreAllMocks()
    mockFetch(() => new Response('down', { status: 503 }))
    expect(await getProvider(type).send(config, message())).toMatchObject({ ok: false, retryable: true })
  })
})

it.each(['invalid', 'sctpkey', 'sctp123t', 'SCTkey/../other', 'SCTkey?query', 'sctp123tevil.example'])('rejects malformed Server酱 SendKey %s', async (sendKey) => {
  const res = await adminCall('/channels', { method: 'POST', body: JSON.stringify({ name: 'bad', type: 'serverchan', config: { sendKey } }) })
  expect(res.status).toBe(422)
})

it('fans one channelGroup out to both providers through the delivery state machine', async () => {
  const created = await Promise.all(channels.map(({ type, config }) => createChannel(env, { name: type, type, config })))
  await channelGroupWith('ops', created.map((c) => c.id))
  const q = envWithQueue()
  const result = await sendMessage(q.env, { channelGroup: 'ops', title: '通知', body: '**ready**', format: 'markdown', raw: { pushplus: { content: 'raw pushplus' } } }, { source: 'admin', waitUntil: () => {} })
  expect(q.sent).toHaveLength(2)
  const calls = mockFetch((req) => Response.json(req.url.includes('pushplus') ? { code: 200 } : { code: 0 }))
  for (const sent of q.sent) await processDelivery(q.env, sent.body)
  expect(await getMessage(env.DB, result.messageId)).toMatchObject({ status: 'sent', counts: { sent: 2, pending: 0 } })
  expect(calls.find((c) => c.url.includes('pushplus'))!.json().content).toBe('raw pushplus')
})
