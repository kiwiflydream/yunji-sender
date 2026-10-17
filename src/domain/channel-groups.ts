import { z } from 'zod'
import type { ChannelGroup } from '../shared/types'
import { parseOrThrow, ValidationError } from './errors'

export const CHANNEL_GROUP_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

export const channelGroupInputSchema = z.object({
  slug: z.string().trim().regex(CHANNEL_GROUP_SLUG_RE, '只能包含小写字母、数字、点、下划线和连字符，以字母或数字开头'),
  name: z.string().trim().min(1, '名称不能为空').max(100),
  description: z.string().trim().max(500).default(''),
  channelIds: z.array(z.string().min(1)).max(50).default([]),
})

interface ChannelGroupRow {
  id: string
  slug: string
  name: string
  description: string
  channel_ids: string | null
  created_at: number
  updated_at: number
}

const rowToChannelGroup = (r: ChannelGroupRow): ChannelGroup => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  description: r.description,
  channelIds: r.channel_ids ? r.channel_ids.split(',') : [],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const SELECT = `SELECT t.*, (SELECT group_concat(channel_id) FROM channel_group_channels WHERE channel_group_id = t.id) AS channel_ids FROM channel_groups t`

export async function listChannelGroups(db: D1Database): Promise<ChannelGroup[]> {
  const { results } = await db.prepare(`${SELECT} ORDER BY t.slug`).all<ChannelGroupRow>()
  return results.map(rowToChannelGroup)
}

export async function getChannelGroup(db: D1Database, id: string): Promise<ChannelGroup | null> {
  const r = await db.prepare(`${SELECT} WHERE t.id = ?`).bind(id).first<ChannelGroupRow>()
  return r ? rowToChannelGroup(r) : null
}

async function assertChannelsExist(db: D1Database, ids: string[]) {
  if (ids.length === 0) return
  const { results } = await db
    .prepare(`SELECT id FROM channels WHERE id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids)
    .all<{ id: string }>()
  const found = new Set(results.map((r) => r.id))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length) throw new ValidationError([{ path: 'channelIds', message: `渠道不存在：${missing.join(', ')}` }])
}

function bindStatements(db: D1Database, channelGroupId: string, channelIds: string[]): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM channel_group_channels WHERE channel_group_id = ?').bind(channelGroupId),
    ...channelIds.map((cid) => db.prepare('INSERT INTO channel_group_channels (channel_group_id, channel_id) VALUES (?, ?)').bind(channelGroupId, cid)),
  ]
}

const isUniqueViolation = (err: unknown) => err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
const slugTaken = () => new ValidationError([{ path: 'slug', message: '标识已被其他渠道组使用' }])

export async function createChannelGroup(db: D1Database, raw: unknown, now = Date.now()): Promise<ChannelGroup> {
  const input = parseOrThrow(channelGroupInputSchema, raw)
  const channelIds = [...new Set(input.channelIds)]
  await assertChannelsExist(db, channelIds)
  const id = crypto.randomUUID()
  try {
    await db.batch([
      db.prepare('INSERT INTO channel_groups (id, slug, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, input.slug, input.name, input.description, now, now),
      ...bindStatements(db, id, channelIds),
    ])
  } catch (err) {
    if (isUniqueViolation(err)) throw slugTaken()
    throw err
  }
  return (await getChannelGroup(db, id))!
}

export async function updateChannelGroup(db: D1Database, id: string, raw: unknown, now = Date.now()): Promise<ChannelGroup | null> {
  const input = parseOrThrow(channelGroupInputSchema, raw)
  const channelIds = [...new Set(input.channelIds)]
  if (!(await getChannelGroup(db, id))) return null
  await assertChannelsExist(db, channelIds)
  try {
    await db.batch([
      db.prepare('UPDATE channel_groups SET slug = ?, name = ?, description = ?, updated_at = ? WHERE id = ?')
        .bind(input.slug, input.name, input.description, now, id),
      ...bindStatements(db, id, channelIds),
    ])
  } catch (err) {
    if (isUniqueViolation(err)) throw slugTaken()
    throw err
  }
  return getChannelGroup(db, id)
}

export async function deleteChannelGroup(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM channel_groups WHERE id = ?').bind(id).run()
  return res.meta.changes > 0
}
