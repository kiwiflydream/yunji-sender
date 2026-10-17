import { Hono } from 'hono'
import { requireApiKey, type ApiVariables } from '../auth/api-key'
import { cancelMessage, getMessage, sendMessage } from '../domain/messages'
import { handleError, jsonBody, waitUntilOf } from './errors'

/** Public API, authenticated with API keys. Keys only see messages they sent. */
export const api = new Hono<{ Bindings: CloudflareBindings; Variables: ApiVariables }>()

api.onError(handleError)
api.notFound((c) => c.json({ error: 'not_found' }, 404))
api.use('*', requireApiKey)

api.post('/send', async (c) => {
  const result = await sendMessage(c.env, await jsonBody(c.req.raw), {
    source: 'api',
    caller: c.get('caller'),
    idempotencyKey: c.req.header('idempotency-key') ?? null,
    waitUntil: waitUntilOf(c),
  })
  return c.json(result, result.duplicate ? 200 : 202)
})

api.get('/messages/:id', async (c) => {
  const message = await getMessage(c.env.DB, c.req.param('id'))
  if (!message || message.apiKeyId !== c.get('caller').id) return c.json({ error: 'not_found' }, 404)
  return c.json({ message })
})

api.post('/messages/:id/cancel', async (c) => {
  const message = await getMessage(c.env.DB, c.req.param('id'))
  if (!message || message.apiKeyId !== c.get('caller').id) return c.json({ error: 'not_found' }, 404)
  return c.json({ canceled: await cancelMessage(c.env.DB, message.id) })
})
