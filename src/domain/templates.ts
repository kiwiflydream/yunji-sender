import { z } from 'zod'
import { renderedTemplateLength, renderTemplate, templateVariables, validTemplateText } from '../shared/templates'
import { MESSAGE_FORMATS, MESSAGE_LEVELS, type MessageTemplate } from '../shared/types'
import { parseOrThrow, ValidationError } from './errors'

const TEMPLATE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const idSchema = z.string().trim().regex(TEMPLATE_ID, '模板 ID 只能包含小写字母、数字、点、下划线和连字符')
  .refine((id) => id !== 'new', 'new 是保留标识，请使用其他模板 ID')
const textSchema = (max: number) => z.string().max(max).refine(validTemplateText, '变量请使用 {{variableName}}，变量名以字母开头，只含字母、数字和下划线')

export const templateInputSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1, '名称不能为空').max(100),
  description: z.string().trim().max(500).default(''),
  title: textSchema(256).default(''),
  body: textSchema(16 * 1024).default(''),
  format: z.enum(MESSAGE_FORMATS).default('text'),
  level: z.enum(MESSAGE_LEVELS).default('info'),
  channelGroup: z.string().trim().min(1).max(64).nullable().default(null),
  channels: z.array(z.string().min(1)).max(50).default([]),
}).refine((v) => !!v.title.trim() || !!v.body.trim(), { path: ['body'], message: '标题和正文至少填一个' })
  .refine((v) => templateVariables(v).length <= 50, { path: ['body'], message: '模板最多使用 50 个变量' })

const templateSendSchema = z.object({
  templateId: idSchema,
  variables: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), z.union([z.string().max(16 * 1024), z.number().finite(), z.boolean()]))
    .refine((v) => Object.keys(v).length <= 50 && JSON.stringify(v).length <= 32 * 1024, '变量最多 50 个，总长度不能超过 32 KB').default({}),
  channelGroup: z.string().trim().min(1).max(64).optional(),
  channels: z.array(z.string().trim().min(1)).max(50).optional(),
  sendAt: z.union([z.number().int().positive(), z.string().trim().min(1)]).optional(),
}).strict()

interface TemplateRow {
  id: string
  name: string
  description: string
  content: string
  channel_group_slug: string | null
  channel_ids: string
  created_at: number
  updated_at: number
}

function fromRow(row: TemplateRow): MessageTemplate {
  const content = JSON.parse(row.content)
  return { id: row.id, name: row.name, description: row.description, ...content,
    channelGroup: row.channel_group_slug, channels: JSON.parse(row.channel_ids), variables: templateVariables(content),
    createdAt: row.created_at, updatedAt: row.updated_at }
}

export async function listTemplates(db: D1Database): Promise<MessageTemplate[]> {
  const { results } = await db.prepare('SELECT * FROM message_templates ORDER BY id').all<TemplateRow>()
  return results.map(fromRow)
}

export async function getTemplate(db: D1Database, id: string): Promise<MessageTemplate | null> {
  const row = await db.prepare('SELECT * FROM message_templates WHERE id = ?').bind(id).first<TemplateRow>()
  return row ? fromRow(row) : null
}

async function validateTargets(db: D1Database, channelGroup: string | null, channels: string[]) {
  if (channelGroup && !(await db.prepare('SELECT 1 FROM channel_groups WHERE slug = ?').bind(channelGroup).first())) {
    throw new ValidationError([{ path: 'channelGroup', message: '渠道组不存在' }])
  }
  if (channels.length) {
    const { results } = await db.prepare(`SELECT id FROM channels WHERE id IN (${channels.map(() => '?').join(',')})`).bind(...channels).all<{ id: string }>()
    const found = new Set(results.map((r) => r.id))
    if (channels.some((id) => !found.has(id))) throw new ValidationError([{ path: 'channels', message: '选择的渠道不存在，请重新选择' }])
  }
}

export async function saveTemplate(db: D1Database, raw: unknown, existingId?: string, now = Date.now()): Promise<MessageTemplate | null> {
  const input = parseOrThrow(templateInputSchema, raw)
  if (existingId && !(await getTemplate(db, existingId))) return null
  if (existingId && input.id !== existingId) throw new ValidationError([{ path: 'id', message: '模板 ID 创建后不能修改' }])
  const channels = [...new Set(input.channels)]
  await validateTargets(db, input.channelGroup, channels)
  const content = JSON.stringify({ title: input.title, body: input.body, format: input.format, level: input.level })
  try {
    if (existingId) {
      await db.prepare('UPDATE message_templates SET name = ?, description = ?, content = ?, channel_group_slug = ?, channel_ids = ?, updated_at = ? WHERE id = ?')
        .bind(input.name, input.description, content, input.channelGroup, JSON.stringify(channels), now, existingId).run()
    } else {
      await db.prepare('INSERT INTO message_templates (id, name, description, content, channel_group_slug, channel_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(input.id, input.name, input.description, content, input.channelGroup, JSON.stringify(channels), now, now).run()
    }
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) throw new ValidationError([{ path: 'id', message: '模板 ID 已存在' }])
    throw err
  }
  return getTemplate(db, input.id)
}

export async function deleteTemplate(db: D1Database, id: string): Promise<boolean> {
  return (await db.prepare('DELETE FROM message_templates WHERE id = ?').bind(id).run()).meta.changes > 0
}

/** Expand before normal message validation and authorization; saved routes never bypass key scopes. */
export async function expandTemplateRequest(db: D1Database, raw: unknown): Promise<unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  if (!Object.hasOwn(raw, 'templateId')) {
    if (Object.hasOwn(raw, 'variables')) throw new ValidationError([{ path: 'templateId', message: '传入 variables 时必须指定 templateId' }])
    return raw
  }
  const input = parseOrThrow(templateSendSchema, raw)
  const template = await getTemplate(db, input.templateId)
  if (!template) throw new ValidationError([{ path: 'templateId', message: '模板不存在' }])
  if (renderedTemplateLength(template.title, input.variables) > 256) throw new ValidationError([{ path: 'title', message: '模板渲染后的标题不能超过 256 字符' }])
  if (renderedTemplateLength(template.body, input.variables) > 16 * 1024) throw new ValidationError([{ path: 'body', message: '模板渲染后的正文不能超过 16 KB' }])
  const rendered = renderTemplate(template, input.variables)
  if (rendered.missing.length) throw new ValidationError(rendered.missing.map((key) => ({ path: `variables.${key}`, message: `缺少变量：${key}` })))
  const overrideTargets = input.channelGroup !== undefined || input.channels !== undefined
  const channelGroup = overrideTargets ? input.channelGroup : template.channelGroup ?? undefined
  const channels = overrideTargets ? input.channels : template.channels
  if (!channelGroup && !channels?.length) throw new ValidationError([{ path: 'channels', message: '请为模板设置默认发送目标，或在请求中指定 channelGroup / channels' }])
  return { title: rendered.title, body: rendered.body, format: template.format, level: template.level, channelGroup, channels, sendAt: input.sendAt }
}
