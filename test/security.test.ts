import { env } from 'cloudflare:workers'
import { afterEach, expect, it, vi } from 'vitest'
import { createChannel } from '../src/domain/channels'
import { processDelivery } from '../src/delivery/process'
import { collectSecretValues, redact } from '../src/lib/redact'
import { apiCall, apiKey, channelGroupWith, envWithQueue, mockFetch, webhookChannel } from './helpers'

afterEach(() => vi.restoreAllMocks())

it('keeps email recipients and sender fixed for a scoped key, including raw aliases and Bcc', async () => {
  const channel = await createChannel(env, { name: 'mail', type: 'email', config: {
    apiKey: 'review-fixture-key', from: 'sender@example.test', to: 'allowed@example.test',
    cc: 'copy@example.test', replyTo: 'reply@example.test',
  } })
  await channelGroupWith('mail-only', [channel.id])
  const key = await apiKey(['mail-only'])
  const q = envWithQueue()
  const calls = mockFetch(() => Response.json({ id: 'fixture-mail' }))
  const res = await apiCall(key, '/send', { method: 'POST', body: JSON.stringify({
    channelGroup: 'mail-only', body: 'test', raw: { email: {
      from: 'other@example.test', to: ['other@example.test'], cc: ['other@example.test'],
      bcc: ['hidden@example.test'], TO: ['alias@example.test'], BCC: ['alias@example.test'],
      reply_to: 'other@example.test', subject: 'Custom subject', text: 'Custom body',
    } },
  }) }, q.env)
  expect(res.status).toBe(202)
  await processDelivery(q.env, q.sent[0].body)
  expect(calls[0].json()).toEqual({
    from: 'sender@example.test', to: ['allowed@example.test'], cc: ['copy@example.test'],
    reply_to: 'reply@example.test', subject: 'Custom subject', text: 'Custom body',
  })
})

it('removes Bark batch recipients and case aliases while retaining raw content', async () => {
  const channel = await createChannel(env, { name: 'bark', type: 'bark', config: { deviceKey: 'saved-device' } })
  await channelGroupWith('bark-only', [channel.id])
  const key = await apiKey(['bark-only'])
  const q = envWithQueue()
  const calls = mockFetch(() => Response.json({ code: 200 }))
  const res = await apiCall(key, '/send', { method: 'POST', body: JSON.stringify({
    channelGroup: 'bark-only', body: 'test', raw: { bark: {
      body: 'Custom body', device_key: 'other', device_keys: ['other'], DEVICE_KEY: 'alias', DEVICE_KEYS: ['alias'], 'devİce_key': 'unicode-device', 'DEVİCE_KEY': 'other-unicode-device',
    } },
  }) }, q.env)
  expect(res.status).toBe(202)
  await processDelivery(q.env, q.sent[0].body)
  expect(calls[0].json()).toEqual({ body: 'Custom body', device_key: 'saved-device' })
})

it('redacts reflected header credentials from API delivery records before truncating', async () => {
  const secret = 'review-only-token-not-real'
  const channel = await webhookChannel('hook', 'https://hook.example.test', {
    headers: JSON.stringify({ Authorization: `  Bearer ${secret} \t` }),
  })
  await channelGroupWith('hooks', [channel.id])
  const key = await apiKey(['hooks'])
  const q = envWithQueue()
  const calls = mockFetch((req) => Response.json({ padding: 'x'.repeat(1980), auth: req.headers.get('authorization') }))
  const response = await apiCall(key, '/send', { method: 'POST', body: JSON.stringify({ channelGroup: 'hooks', body: 'test' }) }, q.env)
  expect(response.status).toBe(202)
  const { messageId } = await response.json() as { messageId: string }
  await processDelivery(q.env, q.sent[0].body)
  expect(calls[0].headers.get('authorization')).toBe(`Bearer ${secret}`)
  const detail = await apiCall(key, `/messages/${messageId}`, {}, q.env)
  const { message } = await detail.json() as { message: { deliveries: { responseBody: string }[] } }
  const body = message.deliveries[0].responseBody
  expect(body).toContain('***')
  expect(body).not.toContain('review-only')
  expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(2048)
})

it('collects header tokens, cookies, URL credentials and escaped forms without exposing short secrets', () => {
  const url = new URL('https://example.test/hook?key=query-token')
  url.username = 'url-user'
  url.password = 'url-pass-fixture'
  const secrets = collectSecretValues({
    headers: JSON.stringify({ Authorization: 'Bearer bearer-token', Cookie: 'session=cookie-token; other=other-token', 'X-Key': 'a"b\\c' }),
    url: url.href,
    short: 'abc',
  })
  const text = 'bearer-token cookie-token other-token url-user url-pass-fixture query-token abc a\\"b\\\\c a%22b%5Cc'
  const clean = redact(text, secrets)
  expect(clean).toBe(Array(9).fill('***').join(' '))
})

it('handles Basic auth, malformed URL escapes, lone surrogates and lowercase percent encodings', () => {
  const url = new URL('https://example.test/hook?key=review-query')
  url.username = '%invalid'
  url.password = 'url-pass-fixture'
  const basic = btoa('basic-user:basic-pass-fixture')
  const secrets = collectSecretValues({
    url: url.href, headers: JSON.stringify({ Authorization: `Basic ${basic}`, 'X-Padded': '  padded-token \t' }), odd: '\ud800', encoded: 'a/b c',
  })
  const text = ['review-query', 'url-pass-fixture', basic, 'basic-user:basic-pass-fixture', 'basic-pass-fixture',
    JSON.stringify('\ud800').slice(1, -1), 'a%2fb%20c', 'a%2fb+c', 'padded-token'].join(' ')
  expect(redact(text, secrets)).toBe(Array(9).fill('***').join(' '))
})
