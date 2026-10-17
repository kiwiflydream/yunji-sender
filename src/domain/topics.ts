import { z } from 'zod'
import type { Topic } from '../shared/types'
import { parseOrThrow, ValidationError } from './errors'

export const TOPIC_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

export const topicInputSchema = z.object({
  slug: z.string().trim().regex(TOPIC_SLUG_RE, '只能包含小写字母、数字、点、下划线和连字符，以字母或数字开头'),
  name: z.string().trim().min(1, '名称不能为空').max(100),
  description: z.string().trim().max(500).default(''),
  channelIds: z.array(z.string().min(1)).max(50).default([]),
})

interface TopicRow {
  id: string
  slug: string
  name: string
  description: string
  channel_ids: string | null
  created_at: number
  updated_at: number
}

const rowToTopic = (r: TopicRow): Topic => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  description: r.description,
  channelIds: r.channel_ids ? r.channel_ids.split(',') : [],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const SELECT = `SELECT t.*, (SELECT group_concat(channel_id) FROM topic_channels WHERE topic_id = t.id) AS channel_ids FROM topics t`

export async function listTopics(db: D1Database): Promise<Topic[]> {
  const { results } = await db.prepare(`${SELECT} ORDER BY t.slug`).all<TopicRow>()
  return results.map(rowToTopic)
}

export async function getTopic(db: D1Database, id: string): Promise<Topic | null> {
  const r = await db.prepare(`${SELECT} WHERE t.id = ?`).bind(id).first<TopicRow>()
  return r ? rowToTopic(r) : null
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

function bindStatements(db: D1Database, topicId: string, channelIds: string[]): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM topic_channels WHERE topic_id = ?').bind(topicId),
    ...channelIds.map((cid) => db.prepare('INSERT INTO topic_channels (topic_id, channel_id) VALUES (?, ?)').bind(topicId, cid)),
  ]
}

const isUniqueViolation = (err: unknown) => err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
const slugTaken = () => new ValidationError([{ path: 'slug', message: '标识已被其他主题使用' }])

export async function createTopic(db: D1Database, raw: unknown, now = Date.now()): Promise<Topic> {
  const input = parseOrThrow(topicInputSchema, raw)
  const channelIds = [...new Set(input.channelIds)]
  await assertChannelsExist(db, channelIds)
  const id = crypto.randomUUID()
  try {
    await db.batch([
      db.prepare('INSERT INTO topics (id, slug, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, input.slug, input.name, input.description, now, now),
      ...bindStatements(db, id, channelIds),
    ])
  } catch (err) {
    if (isUniqueViolation(err)) throw slugTaken()
    throw err
  }
  return (await getTopic(db, id))!
}

export async function updateTopic(db: D1Database, id: string, raw: unknown, now = Date.now()): Promise<Topic | null> {
  const input = parseOrThrow(topicInputSchema, raw)
  const channelIds = [...new Set(input.channelIds)]
  if (!(await getTopic(db, id))) return null
  await assertChannelsExist(db, channelIds)
  try {
    await db.batch([
      db.prepare('UPDATE topics SET slug = ?, name = ?, description = ?, updated_at = ? WHERE id = ?')
        .bind(input.slug, input.name, input.description, now, id),
      ...bindStatements(db, id, channelIds),
    ])
  } catch (err) {
    if (isUniqueViolation(err)) throw slugTaken()
    throw err
  }
  return getTopic(db, id)
}

export async function deleteTopic(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM topics WHERE id = ?').bind(id).run()
  return res.meta.changes > 0
}
