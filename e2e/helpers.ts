import { expect } from '@playwright/test'
import type { Channel, ChannelGroup, MessageDetail, MessageTemplate, SendResult } from '../src/shared/types'

export const baseURL = process.env.E2E_BASE_URL!
export const providerURL = process.env.E2E_PROVIDER_URL!
const basic = `Basic ${Buffer.from(`admin:${process.env.E2E_ADMIN_PASSWORD}`).toString('base64')}`

export async function call<T = unknown>(path: string, options: {
  method?: string; data?: unknown; token?: string | null; status?: number; headers?: Record<string, string>
} = {}): Promise<T> {
  const { method = 'GET', data, token, status = 200, headers } = options
  const res = await fetch(`${baseURL}${path}`, {
    method, redirect: 'error',
    headers: {
      ...(token === null ? {} : { authorization: token === undefined ? basic : `Bearer ${token}` }),
      // Separate the setup client from browser actors in the local simulator.
      'cf-connecting-ip': '192.0.2.250',
      'content-type': 'application/json', origin: baseURL, ...headers,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })
  const text = await res.text()
  expect(res.status, `${method} ${path}: ${text.slice(0, 500)}`).toBe(status)
  return (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text || null) as T
}

export async function waitMessage(id: string, status: string, token?: string): Promise<MessageDetail> {
  let message: MessageDetail | undefined
  await expect.poll(async () => {
    const result = await call<{ message: MessageDetail }>(`${token ? '/api' : '/admin/api'}/messages/${id}`, { token })
    message = result.message
    return message.status
  }, { timeout: 30_000, intervals: [100, 250, 500] }).toBe(status)
  return message!
}

export const createChannel = async (name: string, path = '/ok') =>
  (await call<{ channel: Channel }>('/admin/api/channels', {
    method: 'POST', status: 201, data: { name, type: 'webhook', config: { url: `${providerURL}${path}` } },
  })).channel

export const createKey = (channelGroups: string[] | null = null) =>
  call<{ key: string; info: { id: string } }>('/admin/api/keys', {
    method: 'POST', status: 201, data: { name: 'E2E test key', channelGroups },
  })

export async function seed() {
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`
  const channel = await createChannel(`Fixture ${slug}`)
  const { channelGroup } = await call<{ channelGroup: ChannelGroup }>('/admin/api/channel-groups', {
    method: 'POST', status: 201, data: { slug, name: `Group ${slug}`, channelIds: [channel.id] },
  })
  const { template } = await call<{ template: MessageTemplate }>('/admin/api/templates', {
    method: 'POST', status: 201, data: { id: slug, name: `Order ${slug}`, body: 'Order {{orderId}}', channelGroup: slug },
  })
  const key = await createKey([slug])
  const sent = await call<SendResult>('/api/send', {
    method: 'POST', status: 202, token: key.key, data: { templateId: template.id, variables: { orderId: 'TEST-001' } },
  })
  await waitMessage(sent.messageId, 'sent', key.key)
  return { channel, channelGroup, template, key, messageId: sent.messageId }
}

export interface ProviderRecord { path: string; data: { id?: string; body?: string; device_key?: string; [key: string]: unknown } }
export const providerRecords = async () => (await fetch(`${providerURL}/records`)).json() as Promise<ProviderRecord[]>
