// Types shared by the Worker and the admin SPA. Must not depend on Workers
// runtime types (D1Database, Queue, ...).

export const CHANNEL_TYPES = [
  'webhook',
  'telegram',
  'feishu',
  'wecom',
  'dingtalk',
  'slack',
  'discord',
  'bark',
  'email',
] as const
export type ChannelType = (typeof CHANNEL_TYPES)[number]

export const MESSAGE_FORMATS = ['text', 'markdown'] as const
export type MessageFormat = (typeof MESSAGE_FORMATS)[number]
export const MESSAGE_LEVELS = ['info', 'warn', 'error'] as const
export type MessageLevel = (typeof MESSAGE_LEVELS)[number]

/** The normalized message every channel adapter renders. */
export interface MessageContent {
  title: string
  body: string
  format: MessageFormat
  level: MessageLevel
  url: string | null
  tags: string[]
  /** Per channel type: replaces the generated request body (see docs/design.md). */
  raw: Partial<Record<ChannelType, Record<string, unknown>>>
}

export type ChannelConfigValue = string | boolean

export interface Channel {
  id: string
  name: string
  type: ChannelType
  enabled: boolean
  /** Non-secret fields only. */
  config: Record<string, ChannelConfigValue>
  /** Secret fields that currently have a value; values are never returned. */
  secretsSet: string[]
  topicSlugs: string[]
  createdAt: number
  updatedAt: number
}

export interface Topic {
  id: string
  slug: string
  name: string
  description: string
  channelIds: string[]
  createdAt: number
  updatedAt: number
}

export interface ApiKeyInfo {
  id: string
  name: string
  prefix: string
  /** Allowed topic slugs; null means unrestricted (any topic or channel). */
  topics: string[] | null
  lastUsedAt: number | null
  revokedAt: number | null
  createdAt: number
}

export type MessageSource = 'api' | 'rpc' | 'admin'
export type DeliveryStatus = 'scheduled' | 'queued' | 'sending' | 'sent' | 'failed' | 'canceled'
/** Derived from the message's deliveries. */
export type MessageStatus = 'scheduled' | 'pending' | 'sent' | 'partial' | 'failed' | 'canceled'

export interface DeliveryCounts {
  total: number
  sent: number
  failed: number
  canceled: number
  /** scheduled + queued + sending */
  pending: number
  scheduled: number
}

export interface MessageSummary {
  id: string
  topicSlug: string | null
  source: MessageSource
  apiKeyId: string | null
  title: string
  level: MessageLevel
  status: MessageStatus
  counts: DeliveryCounts
  sendAt: number
  createdAt: number
}

export interface Delivery {
  id: string
  messageId: string
  channelId: string
  channelType: ChannelType
  channelName: string
  status: DeliveryStatus
  attempts: number
  nextAttemptAt: number
  durationMs: number | null
  httpStatus: number | null
  responseBody: string | null
  error: string | null
  finishedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface MessageDetail extends MessageSummary {
  content: MessageContent
  deliveries: Delivery[]
}

/** Body of POST /api/send and the argument of the RPC `send()`. */
export interface SendRequest {
  /** Topic slug; its enabled channels receive the message. */
  topic?: string
  /** Channel ids, in addition to (or instead of) the topic. */
  channels?: string[]
  title?: string
  body?: string
  format?: MessageFormat
  level?: MessageLevel
  url?: string | null
  tags?: string[]
  raw?: Partial<Record<ChannelType, Record<string, unknown>>>
  /** Epoch ms or ISO 8601; omitted or past means now. */
  sendAt?: number | string
}

/** Response of POST /api/send and the RPC `send()`. */
export interface SendResult {
  messageId: string
  /** True when an earlier request with the same Idempotency-Key was returned. */
  duplicate: boolean
  sendAt: number
  deliveries: { id: string; channelId: string; channelName: string; channelType: ChannelType; status: DeliveryStatus }[]
}

/** Result of a synchronous channel test. */
export interface ChannelTestResult {
  ok: boolean
  httpStatus: number | null
  error: string | null
  responseBody: string | null
  durationMs: number
}

export interface Issue {
  path: string
  message: string
}

export type AdminAuthMode = 'basic' | 'access'
export type ExecutionMode = 'queue' | 'direct'

export interface RuntimeSettings {
  executionMode: ExecutionMode
  /** Total attempts per delivery, the first included. */
  maxAttempts: number
  retentionDays: number
  statsRetentionDays: number
}

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  executionMode: 'queue',
  maxAttempts: 5,
  retentionDays: 30,
  statsRetentionDays: 90,
}

/** GET /admin/api/me */
export interface AdminMe extends RuntimeSettings {
  user: string
  authMode: AdminAuthMode
  /** Whether the DELIVERY_QUEUE binding is configured. */
  queueAvailable: boolean
}

export type StatsRange = '24h' | '7d' | '30d' | '90d'
export type StatsGranularity = 'hour' | 'day'

export interface StatsSummary {
  total: number
  sent: number
  failed: number
  /** sent / (sent + failed) */
  successRate: number | null
  retries: number
  /** send_at -> sent, ms; null without successful deliveries. */
  latencyAvg: number | null
  latencyMax: number | null
}

export interface StatsPoint {
  t: number
  sent: number
  failed: number
  latencyAvg: number | null
}

export interface StatsBreakdownRow {
  /** Channel id or topic slug ('' = sent straight to channels). */
  key: string
  label: string
  type?: ChannelType
  total: number
  sent: number
  failed: number
  successRate: number | null
  latencyAvg: number | null
}

/** GET /stats */
export interface StatsOverview {
  range: StatsRange
  granularity: StatsGranularity
  from: number
  to: number
  summary: StatsSummary
  series: StatsPoint[]
  byChannel: StatsBreakdownRow[]
  byTopic: StatsBreakdownRow[]
}
