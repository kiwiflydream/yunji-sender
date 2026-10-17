import type {
  AdminMe,
  ApiKeyInfo,
  Channel,
  ChannelConfigValue,
  ChannelTestResult,
  ChannelType,
  Issue,
  MessageDetail,
  MessageStatus,
  MessageSummary,
  RuntimeSettings,
  SendRequest,
  SendResult,
  StatsOverview,
  StatsRange,
  Topic,
} from '../../src/shared/types'
import { viewerTimezone } from './lib/format'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error?: string; message?: string; issues?: Issue[] } | null,
  ) {
    super(body?.issues?.map((i) => i.message).join('；') || body?.message || body?.error || `HTTP ${status}`)
  }

  get issues(): Issue[] {
    return this.body?.issues ?? []
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/admin/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...init.headers },
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {}
  if (!res.ok) throw new ApiError(res.status, body)
  return (body ?? undefined) as T
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
})

export interface ChannelInput {
  name: string
  type: ChannelType
  enabled: boolean
  config: Record<string, ChannelConfigValue>
}

export interface TopicInput {
  slug: string
  name: string
  description: string
  channelIds: string[]
}

export interface MessageFilter {
  status?: MessageStatus
  topic?: string
}

export const api = {
  me: () => request<AdminMe>('/me'),
  channels: () => request<{ channels: Channel[] }>('/channels').then((r) => r.channels),
  channel: (id: string) => request<{ channel: Channel }>(`/channels/${id}`).then((r) => r.channel),
  createChannel: (input: ChannelInput) => request<{ channel: Channel }>('/channels', json('POST', input)).then((r) => r.channel),
  updateChannel: (id: string, input: ChannelInput) =>
    request<{ channel: Channel }>(`/channels/${id}`, json('PUT', input)).then((r) => r.channel),
  deleteChannel: (id: string) => request<void>(`/channels/${id}`, json('DELETE')),
  testChannel: (id: string) => request<{ result: ChannelTestResult }>(`/channels/${id}/test`, json('POST')).then((r) => r.result),
  topics: () => request<{ topics: Topic[] }>('/topics').then((r) => r.topics),
  createTopic: (input: TopicInput) => request<{ topic: Topic }>('/topics', json('POST', input)).then((r) => r.topic),
  updateTopic: (id: string, input: TopicInput) => request<{ topic: Topic }>(`/topics/${id}`, json('PUT', input)).then((r) => r.topic),
  deleteTopic: (id: string) => request<void>(`/topics/${id}`, json('DELETE')),
  keys: () => request<{ keys: ApiKeyInfo[] }>('/keys').then((r) => r.keys),
  createKey: (name: string, topics: string[] | null) =>
    request<{ key: string; info: ApiKeyInfo }>('/keys', json('POST', { name, topics })),
  revokeKey: (id: string) => request<void>(`/keys/${id}/revoke`, json('POST')),
  deleteKey: (id: string) => request<void>(`/keys/${id}`, json('DELETE')),
  send: (input: SendRequest) => request<SendResult>('/send', json('POST', input)),
  messages: (filter: MessageFilter, before?: number) => {
    const q = new URLSearchParams({ limit: '50' })
    if (before) q.set('before', String(before))
    if (filter.status) q.set('status', filter.status)
    if (filter.topic) q.set('topic', filter.topic)
    return request<{ messages: MessageSummary[]; nextBefore: number | null }>(`/messages?${q}`)
  },
  message: (id: string) => request<{ message: MessageDetail }>(`/messages/${id}`).then((r) => r.message),
  cancelMessage: (id: string) => request<{ canceled: number }>(`/messages/${id}/cancel`, json('POST')).then((r) => r.canceled),
  retryDelivery: (id: string) => request<void>(`/deliveries/${id}/retry`, json('POST')),
  stats: (range: StatsRange) => request<StatsOverview>(`/stats?range=${range}&tz=${encodeURIComponent(viewerTimezone)}`),
  putRuntimeSettings: (settings: RuntimeSettings) =>
    request<{ settings: RuntimeSettings }>('/settings/runtime', json('PUT', settings)).then((r) => r.settings),
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
