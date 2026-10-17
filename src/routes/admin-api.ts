import { Hono } from 'hono'
import { z } from 'zod'
import { createApiKey, deleteApiKey, listApiKeys, revokeApiKey } from '../domain/api-keys'
import { testChannel } from '../domain/channel-test'
import { createChannel, deleteChannel, getChannel, listChannels, updateChannel } from '../domain/channels'
import { parseOrThrow, ValidationError } from '../domain/errors'
import { cancelMessage, getMessage, listMessages, listQuerySchema, retryDelivery, sendMessage } from '../domain/messages'
import { getRuntimeSettings, putRuntimeSettings, runtimeSettingsSchema } from '../domain/settings'
import { statsOverview, statsWindow, STATS_RANGES } from '../domain/stats'
import { createChannelGroup, deleteChannelGroup, getChannelGroup, listChannelGroups, updateChannelGroup } from '../domain/channel-groups'
import { deleteTemplate, getTemplate, listTemplates, saveTemplate } from '../domain/templates'
import { hasDeliveryQueue } from '../delivery/mode'
import { isValidTimezone } from '../lib/time'
import { handleError, jsonBody, waitUntilOf } from './errors'

const statsQuerySchema = z.object({
  range: z.enum(STATS_RANGES).default('24h'),
  tz: z.string().default('UTC').refine(isValidTimezone, '无效的时区'),
})

/** JSON API behind admin auth, mounted at /admin/api. */
export const adminApi = new Hono<{ Bindings: CloudflareBindings }>()

adminApi.onError(handleError)

// Channels
adminApi.get('/channels', async (c) => c.json({ channels: await listChannels(c.env) }))
adminApi.post('/channels', async (c) => c.json({ channel: await createChannel(c.env, await jsonBody(c.req.raw)) }, 201))
adminApi.get('/channels/:id', async (c) => {
  const channel = await getChannel(c.env, c.req.param('id'))
  return channel ? c.json({ channel }) : c.json({ error: 'not_found' }, 404)
})
adminApi.put('/channels/:id', async (c) => {
  const channel = await updateChannel(c.env, c.req.param('id'), await jsonBody(c.req.raw))
  return channel ? c.json({ channel }) : c.json({ error: 'not_found' }, 404)
})
adminApi.delete('/channels/:id', async (c) =>
  (await deleteChannel(c.env, c.req.param('id'))) ? c.body(null, 204) : c.json({ error: 'not_found' }, 404),
)
adminApi.post('/channels/:id/test', async (c) => {
  const result = await testChannel(c.env, c.req.param('id'))
  return result ? c.json({ result }) : c.json({ error: 'not_found' }, 404)
})

// ChannelGroups
adminApi.get('/channel-groups', async (c) => c.json({ channelGroups: await listChannelGroups(c.env.DB) }))
adminApi.post('/channel-groups', async (c) => c.json({ channelGroup: await createChannelGroup(c.env.DB, await jsonBody(c.req.raw)) }, 201))
adminApi.get('/channel-groups/:id', async (c) => {
  const channelGroup = await getChannelGroup(c.env.DB, c.req.param('id'))
  return channelGroup ? c.json({ channelGroup }) : c.json({ error: 'not_found' }, 404)
})
adminApi.put('/channel-groups/:id', async (c) => {
  const channelGroup = await updateChannelGroup(c.env.DB, c.req.param('id'), await jsonBody(c.req.raw))
  return channelGroup ? c.json({ channelGroup }) : c.json({ error: 'not_found' }, 404)
})
adminApi.delete('/channel-groups/:id', async (c) =>
  (await deleteChannelGroup(c.env.DB, c.req.param('id'))) ? c.body(null, 204) : c.json({ error: 'not_found' }, 404),
)

// Message templates
adminApi.get('/templates', async (c) => c.json({ templates: await listTemplates(c.env.DB) }))
adminApi.post('/templates', async (c) => c.json({ template: await saveTemplate(c.env.DB, await jsonBody(c.req.raw)) }, 201))
adminApi.get('/templates/:id', async (c) => {
  const template = await getTemplate(c.env.DB, c.req.param('id'))
  return template ? c.json({ template }) : c.json({ error: 'not_found' }, 404)
})
adminApi.put('/templates/:id', async (c) => {
  const template = await saveTemplate(c.env.DB, await jsonBody(c.req.raw), c.req.param('id'))
  return template ? c.json({ template }) : c.json({ error: 'not_found' }, 404)
})
adminApi.delete('/templates/:id', async (c) =>
  (await deleteTemplate(c.env.DB, c.req.param('id'))) ? c.body(null, 204) : c.json({ error: 'not_found' }, 404),
)

// API keys
adminApi.get('/keys', async (c) => c.json({ keys: await listApiKeys(c.env.DB) }))
adminApi.post('/keys', async (c) => c.json(await createApiKey(c.env.DB, await jsonBody(c.req.raw)), 201))
adminApi.post('/keys/:id/revoke', async (c) =>
  (await revokeApiKey(c.env.DB, c.req.param('id'))) ? c.body(null, 204) : c.json({ error: 'not_found' }, 404),
)
adminApi.delete('/keys/:id', async (c) =>
  (await deleteApiKey(c.env.DB, c.req.param('id'))) ? c.body(null, 204) : c.json({ error: 'not_found' }, 404),
)

// Messages
adminApi.post('/send', async (c) => {
  const result = await sendMessage(c.env, await jsonBody(c.req.raw), { source: 'admin', waitUntil: waitUntilOf(c) })
  return c.json(result, 202)
})
adminApi.get('/messages', async (c) => c.json(await listMessages(c.env.DB, parseOrThrow(listQuerySchema, c.req.query()))))
adminApi.get('/messages/:id', async (c) => {
  const message = await getMessage(c.env.DB, c.req.param('id'))
  return message ? c.json({ message }) : c.json({ error: 'not_found' }, 404)
})
adminApi.post('/messages/:id/cancel', async (c) => {
  const canceled = await cancelMessage(c.env.DB, c.req.param('id'))
  return canceled === null ? c.json({ error: 'not_found' }, 404) : c.json({ canceled })
})
adminApi.post('/deliveries/:id/retry', async (c) => {
  const outcome = await retryDelivery(c.env, c.req.param('id'), waitUntilOf(c))
  if (outcome === 'not_found') return c.json({ error: 'not_found' }, 404)
  if (outcome === 'not_retryable') {
    throw new ValidationError([{ path: '', message: '只有失败或已取消的投递可以重试' }])
  }
  return c.body(null, 202)
})

// Stats & settings
adminApi.get('/stats', async (c) => {
  const q = parseOrThrow(statsQuerySchema, c.req.query())
  return c.json(await statsOverview(c.env.DB, statsWindow(q.range, Date.now(), q.tz)))
})
adminApi.get('/settings/runtime', async (c) => c.json({ settings: await getRuntimeSettings(c.env.DB) }))
adminApi.put('/settings/runtime', async (c) => {
  const settings = parseOrThrow(runtimeSettingsSchema, await jsonBody(c.req.raw))
  if (settings.executionMode === 'queue' && !hasDeliveryQueue(c.env)) {
    throw new ValidationError([{ path: 'executionMode', message: '当前部署没有配置 Queue，不能选择队列方式' }])
  }
  await putRuntimeSettings(c.env.DB, settings, Date.now())
  return c.json({ settings })
})

adminApi.all('*', (c) => c.json({ error: 'not_found' }, 404))
