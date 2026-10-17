import { z } from 'zod'
import { decryptString, encryptString } from '../lib/crypto'
import { CHANNEL_CATALOG, type ChannelField } from '../shared/catalog'
import { CHANNEL_TYPES, type Channel, type ChannelConfigValue, type ChannelType, type Issue } from '../shared/types'
import type { ChannelConfig } from '../channels/types'
import { parseOrThrow, ValidationError } from './errors'

export const channelInputSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(100),
  type: z.enum(CHANNEL_TYPES),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
})

export type ChannelInput = z.output<typeof channelInputSchema>

interface ChannelRow {
  id: string
  name: string
  type: ChannelType
  enabled: number
  config: string
  secrets_encrypted: string
  created_at: number
  updated_at: number
  topic_slugs?: string | null
}

function rowToChannel(r: ChannelRow, secrets: Record<string, string>): Channel {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    enabled: r.enabled === 1,
    config: JSON.parse(r.config),
    secretsSet: Object.keys(secrets).filter((k) => secrets[k] !== ''),
    topicSlugs: r.topic_slugs ? r.topic_slugs.split(',').sort() : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** The ciphertext is bound to its channel, so it cannot be copied to another row. */
const aad = (id: string) => `channel:${id}`

async function decryptSecrets(key: string, r: ChannelRow): Promise<Record<string, string>> {
  return JSON.parse(await decryptString(key, r.secrets_encrypted, aad(r.id)))
}

const isUrl = (v: string) => {
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

function checkField(f: ChannelField, raw: unknown, issues: Issue[]): ChannelConfigValue | undefined {
  const path = `config.${f.key}`
  if (f.kind === 'boolean') {
    if (raw === undefined || raw === null || raw === '') return (f.default as boolean | undefined) ?? false
    if (typeof raw !== 'boolean') return void issues.push({ path, message: '必须是布尔值' })
    return raw
  }
  if (raw !== undefined && raw !== null && typeof raw !== 'string') return void issues.push({ path, message: '必须是字符串' })
  const v = ((raw as string | undefined | null) ?? '').trim()
  if (v === '') return typeof f.default === 'string' ? f.default : ''
  if (v.length > (f.kind === 'textarea' ? 8000 : 2048)) return void issues.push({ path, message: '内容过长' })
  if (f.kind === 'url' && !isUrl(v)) return void issues.push({ path, message: '必须是 http:// 或 https:// 开头的 URL' })
  if (f.kind === 'select' && !f.options?.includes(v)) {
    return void issues.push({ path, message: `只能是 ${f.options?.join(' / ')}` })
  }
  return v
}

/** Checks a field-level schema cannot express. */
function checkType(type: ChannelType, c: Record<string, ChannelConfigValue>, issues: Issue[]) {
  const s = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '')
  if (type === 'webhook' && s('headers')) {
    let ok = false
    try {
      const h = JSON.parse(s('headers'))
      ok = !!h && typeof h === 'object' && !Array.isArray(h) && Object.values(h).every((v) => typeof v === 'string')
    } catch {}
    if (!ok) issues.push({ path: 'config.headers', message: '必须是值为字符串的 JSON 对象' })
  }
  if (type === 'telegram' && s('messageThreadId') && !/^\d+$/.test(s('messageThreadId'))) {
    issues.push({ path: 'config.messageThreadId', message: '必须是数字' })
  }
  if (type === 'email') {
    for (const key of ['to', 'cc']) {
      const bad = s(key).split(/[,;\n]/).map((a) => a.trim()).filter(Boolean).find((a) => !/^[^@\s]+@[^@\s]+$/.test(a.replace(/^.*<(.+)>$/, '$1')))
      if (bad) issues.push({ path: `config.${key}`, message: `无效的邮箱地址：${bad}` })
    }
  }
}

/**
 * Validate a channel config against its catalog entry and split it into public
 * and secret parts. An empty secret keeps `existing[key]` (edit without retyping).
 */
export function parseChannelConfig(
  type: ChannelType,
  input: Record<string, unknown>,
  existing: Record<string, string> = {},
): { config: Record<string, ChannelConfigValue>; secrets: Record<string, string> } {
  const issues: Issue[] = []
  const config: Record<string, ChannelConfigValue> = {}
  const secrets: Record<string, string> = {}
  for (const f of CHANNEL_CATALOG[type].fields) {
    let value = checkField(f, input[f.key], issues)
    if (value === undefined) continue
    if (f.secret && value === '' && existing[f.key]) value = existing[f.key]
    if (f.required && value === '') {
      issues.push({ path: `config.${f.key}`, message: `${f.label}不能为空` })
      continue
    }
    if (f.secret) secrets[f.key] = value as string
    else config[f.key] = value
  }
  if (issues.length === 0) checkType(type, { ...config, ...secrets }, issues)
  if (issues.length) throw new ValidationError(issues)
  return { config, secrets }
}

const SELECT = `SELECT c.*, (SELECT group_concat(t.slug) FROM topic_channels tc JOIN topics t ON t.id = tc.topic_id
  WHERE tc.channel_id = c.id) AS topic_slugs FROM channels c`

export async function listChannels(env: CloudflareBindings): Promise<Channel[]> {
  const { results } = await env.DB.prepare(`${SELECT} ORDER BY c.created_at`).all<ChannelRow>()
  return Promise.all(results.map(async (r) => rowToChannel(r, await decryptSecrets(env.ENCRYPTION_KEY, r))))
}

export async function getChannel(env: CloudflareBindings, id: string): Promise<Channel | null> {
  const r = await env.DB.prepare(`${SELECT} WHERE c.id = ?`).bind(id).first<ChannelRow>()
  return r ? rowToChannel(r, await decryptSecrets(env.ENCRYPTION_KEY, r)) : null
}

export interface LoadedChannel {
  id: string
  name: string
  type: ChannelType
  enabled: boolean
  /** Public and secret fields merged, ready for the provider. */
  config: ChannelConfig
  /** Non-empty secret values, for redacting logs. */
  secretValues: string[]
}

export async function loadChannel(env: CloudflareBindings, id: string): Promise<LoadedChannel | null> {
  const r = await env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelRow>()
  if (!r) return null
  const secrets = await decryptSecrets(env.ENCRYPTION_KEY, r)
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    enabled: r.enabled === 1,
    config: { ...JSON.parse(r.config), ...secrets },
    secretValues: Object.values(secrets).filter((v) => v !== ''),
  }
}

export async function createChannel(env: CloudflareBindings, raw: unknown, now = Date.now()): Promise<Channel> {
  const input = parseOrThrow(channelInputSchema, raw)
  const { config, secrets } = parseChannelConfig(input.type, input.config)
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO channels (id, name, type, enabled, config, secrets_encrypted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, input.name, input.type, input.enabled ? 1 : 0, JSON.stringify(config),
      await encryptString(env.ENCRYPTION_KEY, JSON.stringify(secrets), aad(id)), now, now)
    .run()
  return (await getChannel(env, id))!
}

/** The type is fixed at creation: its fields and credentials do not carry over. */
export async function updateChannel(env: CloudflareBindings, id: string, raw: unknown, now = Date.now()): Promise<Channel | null> {
  const row = await env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelRow>()
  if (!row) return null
  const input = parseOrThrow(channelInputSchema, raw)
  if (input.type !== row.type) throw new ValidationError([{ path: 'type', message: '渠道类型创建后不能修改' }])
  const existing = await decryptSecrets(env.ENCRYPTION_KEY, row)
  const { config, secrets } = parseChannelConfig(input.type, input.config, existing)
  await env.DB.prepare(
    'UPDATE channels SET name = ?, enabled = ?, config = ?, secrets_encrypted = ?, updated_at = ? WHERE id = ?',
  )
    .bind(input.name, input.enabled ? 1 : 0, JSON.stringify(config),
      await encryptString(env.ENCRYPTION_KEY, JSON.stringify(secrets), aad(id)), now, id)
    .run()
  return getChannel(env, id)
}

/** Topic bindings go with it (FK cascade); past deliveries keep a name snapshot. */
export async function deleteChannel(env: CloudflareBindings, id: string): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(id).run()
  return res.meta.changes > 0
}
