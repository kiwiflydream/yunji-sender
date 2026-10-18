import { z } from 'zod'
import { sha256Hex } from '../lib/hmac'
import type { ApiKeyInfo } from '../shared/types'
import { parseOrThrow } from './errors'
import { CHANNEL_GROUP_SLUG_RE } from './channel-groups'

export const KEY_PREFIX = 'cfs_'
/** last_used_at is refreshed at most this often, to keep authentication read-only most of the time. */
const LAST_USED_RESOLUTION_MS = 60_000

export const apiKeyInputSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(100),
  /** null / omitted: unrestricted. */
  channelGroups: z.array(z.string().trim().regex(CHANNEL_GROUP_SLUG_RE, '无效的渠道组标识')).max(50).nullable().default(null),
}).strict()

interface ApiKeyRow {
  id: string
  name: string
  prefix: string
  channel_groups: string | null
  last_used_at: number | null
  revoked_at: number | null
  created_at: number
}

const rowToInfo = (r: ApiKeyRow): ApiKeyInfo => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  channelGroups: r.channel_groups === null ? null : JSON.parse(r.channel_groups),
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
  createdAt: r.created_at,
})

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return KEY_PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function listApiKeys(db: D1Database): Promise<ApiKeyInfo[]> {
  const { results } = await db
    .prepare('SELECT id, name, prefix, channel_groups, last_used_at, revoked_at, created_at FROM api_keys ORDER BY created_at DESC')
    .all<ApiKeyRow>()
  return results.map(rowToInfo)
}

/** Returns the plaintext key once; only its hash is stored. */
export async function createApiKey(db: D1Database, raw: unknown, now = Date.now()): Promise<{ key: string; info: ApiKeyInfo }> {
  const input = parseOrThrow(apiKeyInputSchema, raw)
  const key = randomKey()
  const row: ApiKeyRow = {
    id: crypto.randomUUID(),
    name: input.name,
    prefix: key.slice(0, KEY_PREFIX.length + 6),
    channel_groups: input.channelGroups === null ? null : JSON.stringify([...new Set(input.channelGroups)]),
    last_used_at: null,
    revoked_at: null,
    created_at: now,
  }
  await db
    .prepare('INSERT INTO api_keys (id, name, prefix, key_hash, channel_groups, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.name, row.prefix, await sha256Hex(key), row.channel_groups, now)
    .run()
  return { key, info: rowToInfo(row) }
}

export async function revokeApiKey(db: D1Database, id: string, now = Date.now()): Promise<boolean> {
  const res = await db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(now, id).run()
  return res.meta.changes > 0
}

export async function deleteApiKey(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run()
  return res.meta.changes > 0
}

export interface ApiCaller {
  id: string
  channelGroups: string[] | null
}

/** Look up an active key by its hash (the hash lookup is not timing-sensitive). */
export async function verifyApiKey(db: D1Database, key: string, now = Date.now()): Promise<ApiCaller | null> {
  if (!/^cfs_[A-Za-z0-9_-]{32}$/.test(key)) return null
  const row = await db
    .prepare('SELECT id, channel_groups, last_used_at FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL')
    .bind(await sha256Hex(key))
    .first<{ id: string; channel_groups: string | null; last_used_at: number | null }>()
  if (!row) return null
  if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_RESOLUTION_MS) {
    await db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(now, row.id).run()
  }
  return { id: row.id, channelGroups: row.channel_groups === null ? null : JSON.parse(row.channel_groups) }
}
