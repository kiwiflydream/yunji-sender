import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRetryAfter } from '../src/channels/http'
import { getProvider } from '../src/channels/registry'
import { TELEGRAM_TEXT_LIMIT } from '../src/channels/providers/telegram'
import type { ChannelConfig, OutboundMessage } from '../src/channels/types'
import type { ChannelType } from '../src/shared/types'
import { hmacSha256, toBase64, toHex } from '../src/lib/hmac'
import { mockFetch } from './helpers'

afterEach(() => vi.restoreAllMocks())

const msg = (overrides: Partial<OutboundMessage> = {}): OutboundMessage => ({
  deliveryId: 'dlv-1',
  messageId: 'msg-1',
  channelGroup: 'ops',
  createdAt: Date.UTC(2026, 9, 17),
  title: '磁盘告警',
  body: '使用率 **95%**',
  format: 'markdown',
  level: 'error',
  url: 'https://grafana.test/d/1',
  tags: ['prod'],
  raw: null,
  ...overrides,
})

describe('webhook', () => {
  it('posts the normalized message with custom headers and an HMAC signature', async () => {
    const calls = mockFetch(() => new Response('ok'))
    const out = await getProvider('webhook').send(
      { url: 'https://hooks.test/x', method: 'PUT', headers: '{"x-token":"abc"}', signingSecret: 'shh' },
      msg(),
    )
    expect(out.ok).toBe(true)
    const [call] = calls
    expect(call.method).toBe('PUT')
    expect(call.headers.get('x-token')).toBe('abc')
    expect(call.headers.get('x-sender-delivery')).toBe('dlv-1')
    expect(call.json()).toMatchObject({ id: 'msg-1', channelGroup: 'ops', title: '磁盘告警', level: 'error', tags: ['prod'] })
    const ts = call.headers.get('x-sender-timestamp')!
    const expected = toHex(await hmacSha256('shh', `${ts}.${call.body}`))
    expect(call.headers.get('x-sender-signature')).toBe(`sha256=${expected}`)
  })

  it('sends raw bodies verbatim', async () => {
    const calls = mockFetch(() => new Response('ok'))
    await getProvider('webhook').send({ url: 'https://hooks.test/x', method: 'POST' }, msg({ raw: { custom: 1 } }))
    expect(calls[0].json()).toEqual({ custom: 1 })
  })
})

describe('telegram', () => {
  it('sends HTML with the title, link and tags', async () => {
    const calls = mockFetch(() => Response.json({ ok: true, result: {} }))
    const out = await getProvider('telegram').send(
      { botToken: '123:abc', chatId: '-100', messageThreadId: '7', apiBase: 'https://tg.proxy.test/', silent: true },
      msg(),
    )
    expect(out.ok).toBe(true)
    expect(calls[0].url).toBe('https://tg.proxy.test/bot123:abc/sendMessage')
    const body = calls[0].json()
    expect(body).toMatchObject({ chat_id: '-100', message_thread_id: 7, parse_mode: 'HTML', disable_notification: true })
    expect(body.text).toContain('<b>🚨 磁盘告警</b>')
    expect(body.text).toContain('使用率 <b>95%</b>')
    expect(body.text).toContain('#prod')
  })

  it('falls back to truncated plain text when the HTML is too long', async () => {
    const calls = mockFetch(() => Response.json({ ok: true }))
    await getProvider('telegram').send({ botToken: 't', chatId: '1' }, msg({ body: '**x** '.repeat(2000) }))
    const body = calls[0].json()
    expect(body.parse_mode).toBeUndefined()
    expect(body.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
  })

  it('treats 429 as retryable with retry_after', async () => {
    mockFetch(() => Response.json({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } }, { status: 429 }))
    const out = await getProvider('telegram').send({ botToken: 't', chatId: '1' }, msg())
    expect(out).toMatchObject({ ok: false, retryable: true, retryAfterMs: 7000, httpStatus: 429 })
  })

  it('treats a bad chat id as permanent', async () => {
    mockFetch(() => Response.json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, { status: 400 }))
    const out = await getProvider('telegram').send({ botToken: 't', chatId: '1' }, msg())
    expect(out).toMatchObject({ ok: false, retryable: false, error: 'HTTP 400: Bad Request: chat not found' })
  })
})

describe('feishu', () => {
  it('sends Markdown as a card and signs it', async () => {
    const calls = mockFetch(() => Response.json({ code: 0, msg: 'success' }))
    const out = await getProvider('feishu').send({ webhookUrl: 'https://open.feishu.test/hook/x', signSecret: 'sec' }, msg())
    expect(out.ok).toBe(true)
    const body = calls[0].json()
    expect(body.msg_type).toBe('interactive')
    expect(body.card.header).toEqual({ title: { tag: 'plain_text', content: '🚨 磁盘告警' }, template: 'red' })
    expect(body.card.elements[0].content).toContain('使用率 **95%**')
    expect(body.sign).toBe(toBase64(await hmacSha256(`${body.timestamp}\nsec`, '')))
  })

  it('sends text as text, and maps business errors', async () => {
    const calls = mockFetch(() => Response.json({ code: 19021, msg: 'sign match fail' }))
    const out = await getProvider('feishu').send({ webhookUrl: 'https://open.feishu.test/hook/x' }, msg({ format: 'text' }))
    expect(calls[0].json()).toEqual({ msg_type: 'text', content: { text: expect.stringContaining('🚨 磁盘告警') } })
    expect(out).toMatchObject({ ok: false, retryable: false, error: expect.stringContaining('19021') })
  })

  it('retries frequency limits', async () => {
    mockFetch(() => Response.json({ code: 9499, msg: 'too many request' }))
    const out = await getProvider('feishu').send({ webhookUrl: 'https://open.feishu.test/hook/x' }, msg())
    expect(out).toMatchObject({ ok: false, retryable: true })
  })
})

describe('wecom', () => {
  it('sends markdown and retries 45009', async () => {
    const calls = mockFetch(() => Response.json({ errcode: 45009, errmsg: 'api freq out of limit' }))
    const out = await getProvider('wecom').send({ webhookUrl: 'https://qyapi.test/send?key=k' }, msg())
    expect(calls[0].json()).toEqual({ msgtype: 'markdown', markdown: { content: expect.stringMatching(/^## 🚨 磁盘告警\n\n使用率 \*\*95%\*\*/) } })
    expect(out).toMatchObject({ ok: false, retryable: true })
  })

  it('caps text at 2048 bytes', async () => {
    const calls = mockFetch(() => Response.json({ errcode: 0 }))
    await getProvider('wecom').send({ webhookUrl: 'https://qyapi.test/send?key=k' }, msg({ format: 'text', body: '字'.repeat(2000) }))
    const content = calls[0].json().text.content
    expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(2048)
  })
})

describe('dingtalk', () => {
  it('signs the URL and sends markdown', async () => {
    const calls = mockFetch(() => Response.json({ errcode: 0, errmsg: 'ok' }))
    const out = await getProvider('dingtalk').send({ webhookUrl: 'https://oapi.test/robot/send?access_token=t', signSecret: 'SECx' }, msg())
    expect(out.ok).toBe(true)
    const url = new URL(calls[0].url)
    const ts = url.searchParams.get('timestamp')!
    expect(url.searchParams.get('access_token')).toBe('t')
    expect(url.searchParams.get('sign')).toBe(toBase64(await hmacSha256('SECx', `${ts}\nSECx`)))
    expect(calls[0].json()).toMatchObject({ msgtype: 'markdown', markdown: { title: '磁盘告警', text: expect.stringContaining('### 🚨 磁盘告警') } })
  })

  it('retries "send too fast"', async () => {
    mockFetch(() => Response.json({ errcode: 130101, errmsg: 'send too fast' }))
    const out = await getProvider('dingtalk').send({ webhookUrl: 'https://oapi.test/robot/send?access_token=t' }, msg())
    expect(out).toMatchObject({ ok: false, retryable: true })
  })
})

describe('slack', () => {
  it('converts to mrkdwn blocks and honors Retry-After', async () => {
    const calls = mockFetch(() => new Response('rate_limited', { status: 429, headers: { 'retry-after': '30' } }))
    const out = await getProvider('slack').send({ webhookUrl: 'https://hooks.slack.test/x' }, msg())
    const body = calls[0].json()
    expect(body.blocks[0]).toMatchObject({ type: 'header', text: { text: '🚨 磁盘告警' } })
    expect(body.blocks[1].text.text).toBe('使用率 *95%*')
    expect(body.text).toContain('磁盘告警')
    expect(out).toMatchObject({ ok: false, retryable: true, retryAfterMs: 30_000 })
  })
})

describe('discord', () => {
  it('sends an embed with wait=true and no mentions', async () => {
    const calls = mockFetch(() => Response.json({ id: '1' }))
    await getProvider('discord').send({ webhookUrl: 'https://discord.test/api/webhooks/1/x', username: 'bot' }, msg())
    expect(new URL(calls[0].url).searchParams.get('wait')).toBe('true')
    const body = calls[0].json()
    expect(body).toMatchObject({ username: 'bot', allowed_mentions: { parse: [] } })
    expect(body.embeds[0]).toMatchObject({ title: '🚨 磁盘告警', url: 'https://grafana.test/d/1', color: 0xef4444 })
  })
})

describe('bark', () => {
  it('pushes plain text with the device key', async () => {
    const calls = mockFetch(() => Response.json({ code: 200, message: 'success' }))
    const out = await getProvider('bark').send({ serverUrl: 'https://bark.test/', deviceKey: 'dk', group: 'ops' }, msg())
    expect(out.ok).toBe(true)
    expect(calls[0].url).toBe('https://bark.test/push')
    expect(calls[0].json()).toMatchObject({
      device_key: 'dk',
      title: '磁盘告警',
      body: '使用率 95%\n\n#prod',
      level: 'timeSensitive',
      group: 'ops',
      url: 'https://grafana.test/d/1',
    })
  })
})

describe('email', () => {
  it('sends HTML and text through Resend with an idempotency key', async () => {
    const calls = mockFetch(() => Response.json({ id: 'email-1' }))
    const out = await getProvider('email').send(
      { apiKey: 're_x', from: 'Alerts <a@example.com>', to: 'x@example.com, y@example.com', cc: 'z@example.com' },
      msg(),
    )
    expect(out.ok).toBe(true)
    expect(calls[0].url).toBe('https://api.resend.com/emails')
    expect(calls[0].headers.get('authorization')).toBe('Bearer re_x')
    expect(calls[0].headers.get('idempotency-key')).toBe('dlv-1')
    const body = calls[0].json()
    expect(body).toMatchObject({ from: 'Alerts <a@example.com>', to: ['x@example.com', 'y@example.com'], cc: ['z@example.com'], subject: '[告警] 磁盘告警' })
    expect(body.html).toContain('<strong>95%</strong>')
    expect(body.text).toContain('使用率 95%')
  })

  it('reports validation errors as permanent', async () => {
    mockFetch(() => Response.json({ name: 'validation_error', message: 'Invalid `from` field.' }, { status: 422 }))
    const out = await getProvider('email').send({ apiKey: 're_x', from: 'bad', to: 'x@example.com' }, msg())
    expect(out).toMatchObject({ ok: false, retryable: false, error: 'HTTP 422: Invalid `from` field.' })
  })
})

describe('transport errors', () => {
  it('treats network errors and 5xx as retryable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('connection refused'))
    const net = await getProvider('slack').send({ webhookUrl: 'https://hooks.slack.test/x' }, msg())
    expect(net).toMatchObject({ ok: false, retryable: true, httpStatus: null, error: 'network error: connection refused' })
    vi.restoreAllMocks()
    mockFetch(() => new Response('bad gateway', { status: 502 }))
    const gw = await getProvider('slack').send({ webhookUrl: 'https://hooks.slack.test/x' }, msg())
    expect(gw).toMatchObject({ ok: false, retryable: true, httpStatus: 502 })
  })

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('12')).toBe(12_000)
    expect(parseRetryAfter('1.5')).toBe(1500)
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000)
    expect(parseRetryAfter('soon')).toBeNull()
    expect(parseRetryAfter(null)).toBeNull()
  })
})

const acknowledgmentFixtures: [ChannelType, ChannelConfig, unknown][] = [
  ['feishu', { webhookUrl: 'https://example.test/hook' }, { code: 0 }],
  ['wecom', { webhookUrl: 'https://example.test/hook' }, { errcode: 0 }],
  ['dingtalk', { webhookUrl: 'https://example.test/hook' }, { errcode: 0 }],
  ['bark', { deviceKey: 'fixture' }, { code: 200 }],
  ['telegram', { botToken: 'fixture', chatId: '1' }, { ok: true }],
  ['pushplus', { token: 'fixture' }, { code: 200 }],
  ['serverchan', { sendKey: 'fixture' }, { code: 0 }],
  ['email', { apiKey: 'fixture', from: 'a@example.test', to: 'b@example.test' }, { id: 'accepted' }],
  ['discord', { webhookUrl: 'https://example.test/hook' }, { id: 'accepted' }],
  ['slack', { webhookUrl: 'https://example.test/hook' }, 'ok'],
]

describe.each(acknowledgmentFixtures)('%s acknowledgments', (type, config, success) => {
  it.each(['', '<html>proxy error</html>', '{}', '{"code":"0","errcode":"0","ok":"true","id":1}'])(
    'retries an invalid HTTP 200 response: %j', async (text) => {
      mockFetch(() => new Response(text))
      expect(await getProvider(type).send(config, msg())).toMatchObject({ ok: false, retryable: true, httpStatus: 200 })
    },
  )
  it('accepts its explicit acknowledgment', async () => {
    mockFetch(() => typeof success === 'string' ? new Response(success) : Response.json(success))
    expect((await getProvider(type).send(config, msg())).ok).toBe(true)
  })
  it('keeps unauthorized HTTP errors permanent', async () => {
    mockFetch(() => new Response('<html>unauthorized</html>', { status: 401 }))
    expect(await getProvider(type).send(config, msg())).toMatchObject({ ok: false, retryable: false, httpStatus: 401 })
  })
})

it('rejects a broken acknowledgment body but lets a generic webhook acknowledge by status', async () => {
  mockFetch(() => new Response(new ReadableStream({ start(controller) { controller.error(new Error('body interrupted')) } })))
  expect(await getProvider('feishu').send({ webhookUrl: 'https://example.test/hook' }, msg())).toMatchObject({ ok: false, retryable: true })
  vi.restoreAllMocks()
  mockFetch(() => new Response(null, { status: 204 }))
  expect((await getProvider('webhook').send({ url: 'https://example.test/hook' }, msg())).ok).toBe(true)
})

it('does not follow redirects from a saved target', async () => {
  const calls = mockFetch((request) => {
    expect(request.redirect).toBe('manual')
    return new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/hook' } })
  })
  expect(await getProvider('webhook').send({ url: 'https://example.test/hook' }, msg())).toMatchObject({ ok: false, retryable: false, httpStatus: 302 })
  expect(calls).toHaveLength(1)
})
