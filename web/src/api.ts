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
  MessageTemplate,
  MessageTemplateInput,
  RuntimeSettings,
  SendRequest,
  SendResult,
  StatsOverview,
  StatsRange,
  ChannelGroup,
} from '../../src/shared/types'
import { getLocale, tr } from './i18n'
import { localizeIssue } from './lib/issue-message'
import { viewerTimezone } from './lib/format'

export const issueMessage = (message: string | undefined) => localizeIssue(message, tr)

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

export interface ChannelGroupInput {
  slug: string
  name: string
  description: string
  channelIds: string[]
}

export interface MessageFilter {
  status?: MessageStatus
  channelGroup?: string
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
  channelGroups: () => request<{ channelGroups: ChannelGroup[] }>('/channel-groups').then((r) => r.channelGroups),
  templates: () => request<{ templates: MessageTemplate[] }>('/templates').then((r) => r.templates),
  template: (id: string) => request<{ template: MessageTemplate }>(`/templates/${id}`).then((r) => r.template),
  createTemplate: (input: MessageTemplateInput) => request<{ template: MessageTemplate }>('/templates', json('POST', input)).then((r) => r.template),
  updateTemplate: (input: MessageTemplateInput) => request<{ template: MessageTemplate }>(`/templates/${input.id}`, json('PUT', input)).then((r) => r.template),
  deleteTemplate: (id: string) => request<void>(`/templates/${id}`, json('DELETE')),
  createChannelGroup: (input: ChannelGroupInput) => request<{ channelGroup: ChannelGroup }>('/channel-groups', json('POST', input)).then((r) => r.channelGroup),
  updateChannelGroup: (id: string, input: ChannelGroupInput) => request<{ channelGroup: ChannelGroup }>(`/channel-groups/${id}`, json('PUT', input)).then((r) => r.channelGroup),
  deleteChannelGroup: (id: string) => request<void>(`/channel-groups/${id}`, json('DELETE')),
  keys: () => request<{ keys: ApiKeyInfo[] }>('/keys').then((r) => r.keys),
  createKey: (name: string, channelGroups: string[] | null) =>
    request<{ key: string; info: ApiKeyInfo }>('/keys', json('POST', { name, channelGroups })),
  revokeKey: (id: string) => request<void>(`/keys/${id}/revoke`, json('POST')),
  deleteKey: (id: string) => request<void>(`/keys/${id}`, json('DELETE')),
  send: (input: SendRequest) => request<SendResult>('/send', json('POST', input)),
  messages: (filter: MessageFilter, before?: string) => {
    const q = new URLSearchParams({ limit: '50' })
    if (before) q.set('before', String(before))
    if (filter.status) q.set('status', filter.status)
    if (filter.channelGroup) q.set('channelGroup', filter.channelGroup)
    return request<{ messages: MessageSummary[]; nextBefore: string | null }>(`/messages?${q}`)
  },
  message: (id: string) => request<{ message: MessageDetail }>(`/messages/${id}`).then((r) => r.message),
  cancelMessage: (id: string) => request<{ canceled: number }>(`/messages/${id}/cancel`, json('POST')).then((r) => r.canceled),
  retryDelivery: (id: string) => request<void>(`/deliveries/${id}/retry`, json('POST')),
  stats: (range: StatsRange) => request<StatsOverview>(`/stats?range=${range}&tz=${encodeURIComponent(viewerTimezone)}`),
  putRuntimeSettings: (settings: RuntimeSettings) =>
    request<{ settings: RuntimeSettings }>('/settings/runtime', json('PUT', settings)).then((r) => r.settings),
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError && err.issues.length) {
    return err.issues.map((issue) => issueMessage(issue.message)).join(getLocale() === 'en' ? '; ' : '；')
  }
  const message = err instanceof Error ? err.message : String(err)
  const known: Record<string, string> = {
    unauthorized: '认证失败，请检查登录状态', forbidden: '没有操作权限', not_found: '资源不存在',
    validation_failed: '请检查输入内容', internal_error: '服务器错误，请稍后重试',
    'Failed to fetch': '网络请求失败，请稍后重试', 'Load failed': '网络请求失败，请稍后重试',
    'Invalid input': '输入不符合要求',
  }
  return known[message] ? tr(known[message]) : issueMessage(message) ?? message
}
