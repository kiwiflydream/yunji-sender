import { z } from 'zod'
import { dispatchQueued } from '../delivery/dispatch'
import { effectiveMode, QUEUE_MAX_DELAY_S } from '../delivery/mode'
import type { WaitUntil } from '../delivery/process'
import { deliveriesOf, reopenDelivery } from '../delivery/repo'
import {
  CHANNEL_TYPES,
  MESSAGE_FORMATS,
  MESSAGE_LEVELS,
  type ChannelType,
  type DeliveryCounts,
  type DeliveryStatus,
  type MessageContent,
  type MessageDetail,
  type MessageLevel,
  type MessageSource,
  type MessageStatus,
  type MessageSummary,
  type SendResult,
} from '../shared/types'
import type { ApiCaller } from './api-keys'
import { ForbiddenError, parseOrThrow, ValidationError } from './errors'
import { getRuntimeSettings } from './settings'

export const BODY_LIMIT = 16 * 1024
const RAW_LIMIT = 32 * 1024
export const MAX_SEND_AHEAD_MS = 365 * 24 * 60 * 60_000

const isHttpUrl = (v: string) => {
  try {
    return /^https?:$/.test(new URL(v).protocol)
  } catch {
    return false
  }
}

export const sendInputSchema = z
  .object({
    topic: z.string().trim().min(1).max(64).optional(),
    channels: z.array(z.string().trim().min(1)).max(50).optional(),
    title: z.string().trim().max(256).default(''),
    body: z.string().max(BODY_LIMIT).default(''),
    format: z.enum(MESSAGE_FORMATS).default('text'),
    level: z.enum(MESSAGE_LEVELS).default('info'),
    url: z.preprocess(
      (v) => (v === '' ? null : v),
      z.string().trim().max(2048).refine(isHttpUrl, '必须是 http:// 或 https:// URL').nullish(),
    ),
    tags: z.array(z.string().trim().min(1).max(32)).max(10).default([]),
    raw: z.partialRecord(z.enum(CHANNEL_TYPES), z.record(z.string(), z.unknown())).default({}),
    /** Epoch ms or an ISO 8601 string; omitted or in the past means now. */
    sendAt: z.union([z.number().int().positive(), z.string().trim().min(1)]).optional(),
  })
  .refine((v) => v.title !== '' || v.body.trim() !== '', { path: ['body'], message: 'title 和 body 至少填一个' })
  .refine((v) => !!v.topic || (v.channels?.length ?? 0) > 0, { path: ['topic'], message: '需要 topic 或 channels' })
  .refine((v) => JSON.stringify(v.raw).length <= RAW_LIMIT, { path: ['raw'], message: 'raw 不能超过 32 KB' })


export interface SendOptions {
  source: MessageSource
  /** API callers are subject to their key's topic restriction. */
  caller?: ApiCaller
  idempotencyKey?: string | null
  waitUntil: WaitUntil
  now?: number
}

function resolveSendAt(value: number | string | undefined, now: number): number {
  if (value === undefined) return now
  const at = typeof value === 'number' ? value : Date.parse(value)
  if (Number.isNaN(at)) throw new ValidationError([{ path: 'sendAt', message: '无法解析的时间，请用毫秒时间戳或 ISO 8601' }])
  if (at > now + MAX_SEND_AHEAD_MS) throw new ValidationError([{ path: 'sendAt', message: '最多提前 365 天' }])
  return Math.max(at, now)
}

interface Target {
  id: string
  name: string
  type: ChannelType
  enabled: number
}

async function resolveTargets(db: D1Database, topic: string | undefined, channelIds: string[]): Promise<Target[]> {
  const targets = new Map<string, Target>()
  if (topic) {
    const row = await db.prepare('SELECT id FROM topics WHERE slug = ?').bind(topic).first<{ id: string }>()
    if (!row) throw new ValidationError([{ path: 'topic', message: `主题不存在：${topic}` }])
    const { results } = await db
      .prepare(
        `SELECT c.id, c.name, c.type, c.enabled FROM topic_channels tc JOIN channels c ON c.id = tc.channel_id
         WHERE tc.topic_id = ? AND c.enabled = 1 ORDER BY c.name`,
      )
      .bind(row.id)
      .all<Target>()
    for (const t of results) targets.set(t.id, t)
  }
  if (channelIds.length) {
    const { results } = await db
      .prepare(`SELECT id, name, type, enabled FROM channels WHERE id IN (${channelIds.map(() => '?').join(',')})`)
      .bind(...channelIds)
      .all<Target>()
    const found = new Map(results.map((r) => [r.id, r]))
    const missing = channelIds.filter((id) => !found.has(id))
    if (missing.length) throw new ValidationError([{ path: 'channels', message: `渠道不存在：${missing.join(', ')}` }])
    const disabled = results.filter((r) => r.enabled !== 1)
    if (disabled.length) {
      throw new ValidationError([{ path: 'channels', message: `渠道已停用：${disabled.map((d) => d.name).join(', ')}` }])
    }
    for (const t of results) targets.set(t.id, t)
  }
  return [...targets.values()]
}

const isUniqueViolation = (err: unknown) => err instanceof Error && /UNIQUE constraint failed/i.test(err.message)

async function sendResultOf(db: D1Database, messageId: string, duplicate: boolean): Promise<SendResult | null> {
  const msg = await db.prepare('SELECT send_at FROM messages WHERE id = ?').bind(messageId).first<{ send_at: number }>()
  if (!msg) return null
  const deliveries = await deliveriesOf(db, messageId)
  return {
    messageId,
    duplicate,
    sendAt: msg.send_at,
    deliveries: deliveries.map((d) => ({
      id: d.id,
      channelId: d.channelId,
      channelName: d.channelName,
      channelType: d.channelType,
      status: d.status,
    })),
  }
}

/**
 * Accept a message: validate, fan out to one delivery per channel, persist,
 * then hand due deliveries to the executor. Repeating an Idempotency-Key
 * (per caller) returns the original message instead of sending again.
 */
export async function sendMessage(env: CloudflareBindings, raw: unknown, opts: SendOptions): Promise<SendResult> {
  const now = opts.now ?? Date.now()
  const input = parseOrThrow(sendInputSchema, raw)
  const channelIds = [...new Set(input.channels ?? [])]
  if (opts.caller?.topics) {
    if (channelIds.length) throw new ForbiddenError('此 API Key 只能按主题发送')
    if (!input.topic || !opts.caller.topics.includes(input.topic)) {
      throw new ForbiddenError(`此 API Key 不能发送到主题 ${input.topic ?? ''}`.trim())
    }
  }

  const key = opts.idempotencyKey?.trim()
  if (key !== undefined && (key === '' || key.length > 255)) {
    throw new ValidationError([{ path: 'Idempotency-Key', message: '长度必须在 1 到 255 之间' }])
  }
  const idem = key ? `${opts.caller?.id ?? opts.source}:${key}` : null
  if (idem) {
    const existing = await env.DB.prepare('SELECT id FROM messages WHERE idem = ?').bind(idem).first<{ id: string }>()
    if (existing) return (await sendResultOf(env.DB, existing.id, true))!
  }

  const sendAt = resolveSendAt(input.sendAt, now)
  const targets = await resolveTargets(env.DB, input.topic, channelIds)
  if (targets.length === 0) {
    throw new ValidationError([{ path: 'topic', message: '没有可用的渠道：主题没有绑定渠道，或绑定的渠道都已停用' }])
  }
  const settings = await getRuntimeSettings(env.DB)
  const mode = await effectiveMode(env, settings)
  const delayMs = sendAt - now
  // Due now, or within the queue's delay limit: hand over immediately. Later: the cron dispatches.
  const status: DeliveryStatus =
    delayMs <= 0 || (mode === 'queue' && delayMs <= QUEUE_MAX_DELAY_S * 1000) ? 'queued' : 'scheduled'

  const content: MessageContent = {
    title: input.title,
    body: input.body,
    format: input.format,
    level: input.level,
    url: input.url ?? null,
    tags: input.tags,
    raw: input.raw,
  }
  const messageId = crypto.randomUUID()
  const topic = input.topic ?? null
  const deliveries = targets.map((t) => ({ ...t, deliveryId: crypto.randomUUID() }))
  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO messages (id, topic_slug, source, api_key_id, idem, payload, send_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(messageId, topic, opts.source, opts.caller?.id ?? null, idem, JSON.stringify(content), sendAt, now),
      ...deliveries.map((d) =>
        env.DB
          .prepare(
            `INSERT INTO deliveries (id, message_id, channel_id, channel_type, channel_name, topic_slug, status,
               next_attempt_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(d.deliveryId, messageId, d.id, d.type, d.name, topic, status, sendAt, now, now),
      ),
    ])
  } catch (err) {
    // A concurrent request with the same key won the race.
    if (idem && isUniqueViolation(err)) {
      const existing = await env.DB.prepare('SELECT id FROM messages WHERE idem = ?').bind(idem).first<{ id: string }>()
      if (existing) return (await sendResultOf(env.DB, existing.id, true))!
    }
    throw err
  }

  if (status === 'queued') {
    await dispatchQueued(
      env,
      mode,
      deliveries.map((d) => ({ id: d.deliveryId, attempts: 0, nextAttemptAt: sendAt })),
      opts.waitUntil,
      now,
    )
  }
  return (await sendResultOf(env.DB, messageId, false))!
}

// --- Queries -----------------------------------------------------------------

interface MessageRow {
  id: string
  topic_slug: string | null
  source: MessageSource
  api_key_id: string | null
  title: string
  level: MessageLevel
  payload?: string
  send_at: number
  created_at: number
  total: number
  sent: number
  failed: number
  canceled: number
  pending: number
  scheduled: number
}

export function messageStatus(c: DeliveryCounts, sendAt: number, now: number): MessageStatus {
  if (c.pending > 0) return c.pending === c.scheduled && sendAt > now ? 'scheduled' : 'pending'
  if (c.sent === c.total) return 'sent'
  if (c.sent > 0) return 'partial'
  if (c.failed > 0) return 'failed'
  return 'canceled'
}

/** SQL twin of messageStatus, for filtering (bind `now` once). */
const STATUS_HAVING: Record<MessageStatus, string> = {
  scheduled: 'pending > 0 AND pending = scheduled AND m.send_at > ?',
  pending: 'pending > 0 AND NOT (pending = scheduled AND m.send_at > ?)',
  sent: 'pending = 0 AND sent = total AND ? IS NOT NULL',
  partial: 'pending = 0 AND sent > 0 AND sent < total AND ? IS NOT NULL',
  failed: 'pending = 0 AND sent = 0 AND failed > 0 AND ? IS NOT NULL',
  canceled: 'pending = 0 AND sent = 0 AND failed = 0 AND ? IS NOT NULL',
}

const DELIVERY_COUNTS = `COUNT(d.id) AS total,
  COALESCE(SUM(d.status = 'sent'), 0) AS sent,
  COALESCE(SUM(d.status = 'failed'), 0) AS failed,
  COALESCE(SUM(d.status = 'canceled'), 0) AS canceled,
  COALESCE(SUM(d.status IN ('scheduled', 'queued', 'sending')), 0) AS pending,
  COALESCE(SUM(d.status = 'scheduled'), 0) AS scheduled`

const AGGREGATE = `SELECT m.id, m.topic_slug, m.source, m.api_key_id, m.send_at, m.created_at,
  json_extract(m.payload, '$.title') AS title, json_extract(m.payload, '$.level') AS level,
  ${DELIVERY_COUNTS}`

function rowToSummary(r: MessageRow, now: number): MessageSummary {
  const counts: DeliveryCounts = {
    total: r.total,
    sent: r.sent,
    failed: r.failed,
    canceled: r.canceled,
    pending: r.pending,
    scheduled: r.scheduled,
  }
  return {
    id: r.id,
    topicSlug: r.topic_slug,
    source: r.source,
    apiKeyId: r.api_key_id,
    title: r.title ?? '',
    level: r.level ?? 'info',
    status: messageStatus(counts, r.send_at, now),
    counts,
    sendAt: r.send_at,
    createdAt: r.created_at,
  }
}

export const MESSAGE_STATUSES = ['scheduled', 'pending', 'sent', 'partial', 'failed', 'canceled'] as const

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // New cursors include the id to break timestamp ties; accept old timestamps too.
  before: z.string().max(128).regex(/^[1-9]\d*(?::[A-Za-z0-9-]+)?$/)
    .refine((v) => Number.isSafeInteger(Number(v.split(':')[0])), '无效的分页游标').optional(),
  topic: z.string().trim().min(1).optional(),
  status: z.enum(MESSAGE_STATUSES).optional(),
})

export async function listMessages(
  db: D1Database,
  q: z.output<typeof listQuerySchema>,
  now = Date.now(),
): Promise<{ messages: MessageSummary[]; nextBefore: string | null }> {
  const where: string[] = []
  const params: unknown[] = []
  if (q.before) {
    const [at, id] = q.before.split(':')
    if (id) {
      where.push('(m.created_at, m.id) < (?, ?)')
      params.push(Number(at), id)
    } else {
      where.push('m.created_at < ?')
      params.push(Number(at))
    }
  }
  if (q.topic) {
    where.push('m.topic_slug = ?')
    params.push(q.topic)
  }
  if (q.status) {
    // Probe each candidate via the message_id index while walking messages in
    // cursor order. Apply status before LIMIT so sparse matches fill the page.
    where.push(`EXISTS (
      SELECT ${DELIVERY_COUNTS} FROM deliveries d WHERE d.message_id = m.id
      HAVING ${STATUS_HAVING[q.status]}
    )`)
    params.push(now)
  }
  const { results } = await db
    .prepare(
      `WITH page AS (
         SELECT m.* FROM messages m ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY m.created_at DESC, m.id DESC LIMIT ?
       )
       ${AGGREGATE} FROM page m LEFT JOIN deliveries d ON d.message_id = m.id
       GROUP BY m.id ORDER BY m.created_at DESC, m.id DESC`,
    )
    .bind(...params, q.limit + 1)
    .all<MessageRow>()
  const messages = results.slice(0, q.limit).map((r) => rowToSummary(r, now))
  const last = messages.at(-1)
  return { messages, nextBefore: results.length > q.limit && last ? `${last.createdAt}:${last.id}` : null }
}

export async function getMessage(db: D1Database, id: string, now = Date.now()): Promise<MessageDetail | null> {
  const row = await db
    .prepare(
      `${AGGREGATE}, m.payload FROM messages m LEFT JOIN deliveries d ON d.message_id = m.id WHERE m.id = ? GROUP BY m.id`,
    )
    .bind(id)
    .first<MessageRow>()
  if (!row) return null
  return { ...rowToSummary(row, now), content: JSON.parse(row.payload!), deliveries: await deliveriesOf(db, id) }
}

/** Cancel deliveries that have not started. Returns the number canceled, or null for an unknown message. */
export async function cancelMessage(db: D1Database, id: string, now = Date.now()): Promise<number | null> {
  const exists = await db.prepare('SELECT 1 FROM messages WHERE id = ?').bind(id).first()
  if (!exists) return null
  const res = await db
    .prepare(
      `UPDATE deliveries SET status = 'canceled', finished_at = ?, updated_at = ?
       WHERE message_id = ? AND status IN ('scheduled', 'queued')`,
    )
    .bind(now, now, id)
    .run()
  return res.meta.changes
}

/** Give a failed or canceled delivery one more attempt now. */
export async function retryDelivery(
  env: CloudflareBindings,
  id: string,
  waitUntil: WaitUntil,
  now = Date.now(),
): Promise<'retried' | 'not_found' | 'not_retryable'> {
  const exists = await env.DB.prepare('SELECT 1 FROM deliveries WHERE id = ?').bind(id).first()
  if (!exists) return 'not_found'
  const mode = await effectiveMode(env)
  const reopened = await reopenDelivery(env.DB, id, 'queued', now)
  if (!reopened) return 'not_retryable'
  await dispatchQueued(env, mode, [{ id, attempts: reopened.attempts, nextAttemptAt: now }], waitUntil, now)
  return 'retried'
}
