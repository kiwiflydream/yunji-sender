import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { saveTemplate } from '../src/domain/templates'
import { jsonBody } from '../src/routes/errors'
import { BODY_LIMIT, JSON_REQUEST_LIMIT, RAW_LIMIT, utf8ByteLength } from '../src/shared/limits'
import { renderedTemplateByteLength, renderTemplate } from '../src/shared/templates'
import type { TemplateVariables } from '../src/shared/types'
import { apiCall, apiKey, envWithQueue, webhookChannel } from './helpers'

const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })

it.each([
  ['ASCII boundary', 'a'.repeat(BODY_LIMIT), 202],
  ['Chinese boundary', '中'.repeat(5461) + 'a', 202],
  ['emoji boundary', '🙂'.repeat(4096), 202],
  ['JSON escapes within request limit', '\0'.repeat(BODY_LIMIT), 202],
  ['ASCII over limit', 'a'.repeat(BODY_LIMIT + 1), 422],
  ['Chinese over limit', '中'.repeat(5462), 422],
  ['emoji over limit', '🙂'.repeat(4097), 422],
  ['old character-only bypass', '中'.repeat(BODY_LIMIT), 422],
])('enforces body UTF-8 bytes: %s', async (_, body, status) => {
  const channel = await webhookChannel()
  const key = await apiKey()
  const q = envWithQueue()
  const res = await apiCall(key, '/send', post({ channels: [channel.id], body }), q.env)
  expect(res.status).toBe(status)
  expect(q.sent).toHaveLength(status === 202 ? 1 : 0)
})

it.each([0, 1])('enforces serialized raw UTF-8 bytes, overflow %i', async (overflow) => {
  const channel = await webhookChannel()
  const key = await apiKey()
  const empty = { webhook: { note: '' } }
  const room = RAW_LIMIT - utf8ByteLength(JSON.stringify(empty))
  const raw = { webhook: { note: '中'.repeat(Math.floor(room / 3)) + 'a'.repeat(room % 3 + overflow) } }
  expect(utf8ByteLength(JSON.stringify(raw))).toBe(RAW_LIMIT + overflow)
  const q = envWithQueue()
  const res = await apiCall(key, '/send', post({ channels: [channel.id], body: 'x', raw }), q.env)
  expect(res.status).toBe(overflow ? 422 : 202)
  expect(q.sent).toHaveLength(overflow ? 0 : 1)
})

it('bounds saved templates, individual variables, total variables and expanded bodies in bytes', async () => {
  const channel = await webhookChannel()
  const key = await apiKey()
  await expect(saveTemplate(env.DB, {
    id: 'too-large', name: 'Large', body: '中'.repeat(5462), channels: [channel.id],
  })).rejects.toThrow('正文不能超过 16 KB')
  await saveTemplate(env.DB, { id: 'bounded', name: 'Bounded', body: '{{value}}{{value}}', channels: [channel.id] })
  const q = envWithQueue()
  const send = (variables: Record<string, string>) => apiCall(key, '/send', post({ templateId: 'bounded', variables }), q.env)
  expect((await send({ value: '🙂'.repeat(2048) })).status).toBe(202)
  expect((await send({ value: '🙂'.repeat(2049) })).status).toBe(422)
  expect((await send({ value: '中'.repeat(6000) })).status).toBe(422)
  expect((await send({ value: 'x', a: '中'.repeat(4000), b: '中'.repeat(4000), c: '中'.repeat(4000) })).status).toBe(422)
  expect(q.sent).toHaveLength(1)
})

const renderCases: [string, TemplateVariables][] = [
  ['中{{x}}🙂', { x: '你好' }],
  ['{{x}}{{x}}', { x: '🙂' }],
  ['\ud83d{{x}}', { x: '\ude00' }],
  ['{{x}}\ude00', { x: '\ud83d' }],
  ['{{x}}{{y}}', { x: '\ud83d', y: '\ude00' }],
  ['{{x}}{{missing}}', { x: ' ' }],
  ['{{x}}{{y}}', { x: 0, y: false }],
]
it.each(renderCases.map(([body, values], index) => ({ name: `case ${index + 1}`, body, values })))('measures rendered UTF-8 bytes: $name', ({ body, values }) => {
  const rendered = renderTemplate({ title: '', body }, values)
  expect(renderedTemplateByteLength(body, values)).toBe(new TextEncoder().encode(rendered.body).byteLength)
})

it('accepts a JSON body exactly at the transport boundary', async () => {
  const body = JSON.stringify('a'.repeat(JSON_REQUEST_LIMIT - 2))
  const req = new Request('http://sender.test', { method: 'POST', body })
  expect((await jsonBody(req) as string).length).toBe(JSON_REQUEST_LIMIT - 2)
})

it('returns 413 for oversized declared bodies without creating a message', async () => {
  const key = await apiKey()
  const res = await apiCall(key, '/send', {
    method: 'POST', headers: { 'content-length': String(JSON_REQUEST_LIMIT + 1) }, body: '{}',
  }, envWithQueue().env)
  expect(res.status).toBe(413)
  expect(await res.json()).toEqual({ error: 'payload_too_large', maxBytes: JSON_REQUEST_LIMIT })
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first('n')).toBe(0)
})

it('bounds and cancels streamed bodies even with no Content-Length', async () => {
  const key = await apiKey()
  let pulls = 0
  let canceled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++
      controller.enqueue(new Uint8Array(64 * 1024).fill(32))
      if (pulls === 100) controller.close()
    },
    cancel() { canceled = true },
  })
  const res = await apiCall(key, '/send', { method: 'POST', body }, envWithQueue().env)
  expect(res.status).toBe(413)
  expect(canceled).toBe(true)
  expect(pulls).toBeLessThan(10)
})
