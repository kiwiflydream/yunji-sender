import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { vi } from 'vitest'
import { app } from '../src/app'
import { createApiKey } from '../src/domain/api-keys'
import { createChannel } from '../src/domain/channels'
import { putRuntimeSettings } from '../src/domain/settings'
import { createChannelGroup } from '../src/domain/channel-groups'
import type { DeliveryMessage } from '../src/delivery/mode'
import { DEFAULT_RUNTIME_SETTINGS, type RuntimeSettings } from '../src/shared/types'

export interface SentToQueue {
  body: DeliveryMessage
  delaySeconds?: number
}

/** env whose DELIVERY_QUEUE records messages instead of delivering them. */
export function envWithQueue(opts: { fail?: boolean } = {}) {
  const sent: SentToQueue[] = []
  const queue = {
    send: async (body: DeliveryMessage, o?: QueueSendOptions) => {
      if (opts.fail) throw new Error('queue unavailable')
      sent.push({ body, delaySeconds: o?.delaySeconds })
    },
    sendBatch: async (msgs: Iterable<MessageSendRequest<DeliveryMessage>>) => {
      if (opts.fail) throw new Error('queue unavailable')
      for (const m of msgs) sent.push({ body: m.body, delaySeconds: m.delaySeconds })
    },
  }
  return { env: Object.create(env, { DELIVERY_QUEUE: { value: queue } }) as CloudflareBindings, sent }
}

export const envWithoutQueue = () => Object.create(env, { DELIVERY_QUEUE: { value: undefined } }) as CloudflareBindings

export async function setSettings(overrides: Partial<RuntimeSettings>) {
  await putRuntimeSettings(env.DB, { ...DEFAULT_RUNTIME_SETTINGS, executionMode: 'queue', ...overrides }, Date.now())
}

export interface FetchCall {
  url: string
  method: string
  headers: Headers
  body: string
  json(): any
}

/** Replace global fetch; every call is recorded and answered by `handler`. */
export function mockFetch(handler: (req: Request) => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init)
    const body = await req.clone().text()
    calls.push({ url: req.url, method: req.method, headers: req.headers, body, json: () => JSON.parse(body) })
    return handler(req)
  })
  return calls
}

/** Run a request through the app with a real ExecutionContext and wait for its waitUntil work. */
export async function request(path: string, init: RequestInit = {}, e: CloudflareBindings = env) {
  const ctx = createExecutionContext()
  const res = await app.request(`http://yunji-sender.test${path}`, init, e, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

export const ADMIN_AUTH = { authorization: `Basic ${btoa(`admin:${env.ADMIN_PASSWORD}`)}` }

export function adminCall(path: string, init: RequestInit = {}, e: CloudflareBindings = env) {
  return request(
    `/admin/api${path}`,
    {
      ...init,
      headers: { ...ADMIN_AUTH, 'content-type': 'application/json', origin: 'http://yunji-sender.test', ...(init.headers as Record<string, string>) },
    },
    e,
  )
}

export async function apiCall(key: string, path: string, init: RequestInit = {}, e: CloudflareBindings = env) {
  return request(
    `/api${path}`,
    { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } },
    e,
  )
}

export function webhookChannel(name = 'hook', url = 'https://hooks.test/notify', extra: Record<string, unknown> = {}) {
  return createChannel(env, { name, type: 'webhook', config: { url, ...extra } })
}

export async function channelGroupWith(slug: string, channelIds: string[]) {
  return createChannelGroup(env.DB, { slug, name: slug, channelIds })
}

export async function apiKey(channelGroups: string[] | null = null) {
  return (await createApiKey(env.DB, { name: 'test', channelGroups })).key
}
