import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { DeliveryStatus, MessageStatus, MessageSummary } from '../src/shared/types'
import { adminCall } from './helpers'

async function seedMessage(
  id: string,
  createdAt: number,
  statuses: DeliveryStatus[] = ['sent'],
  channelGroup = 'ops',
  sendAt = createdAt,
) {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO messages (id, source, channel_group_slug, payload, send_at, created_at) VALUES (?, 'admin', ?, ?, ?, ?)`)
      .bind(id, channelGroup, JSON.stringify({ title: id, level: 'info' }), sendAt, createdAt),
    ...statuses.map((status, i) => env.DB.prepare(
      `INSERT INTO deliveries (id, message_id, channel_id, channel_type, channel_name, status, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, 'webhook', 'hook', ?, ?, ?, ?)`,
    ).bind(`${id}-${i}`, id, `ch-${i}`, status, sendAt, createdAt, createdAt)),
  ])
}

async function list(query = '') {
  const res = await adminCall(`/messages?${query}`)
  expect(res.status).toBe(200)
  return res.json() as Promise<{ messages: MessageSummary[]; nextBefore: string | null }>
}

describe('message pagination', () => {
  it('does not skip messages with the same millisecond at the page boundary', async () => {
    for (let i = 0; i < 51; i++) await seedMessage(`m${String(i).padStart(3, '0')}`, 1000)
    const first = await list()
    expect(first.messages).toHaveLength(50)
    expect(first.nextBefore).toBeTruthy()
    const second = await list(`before=${encodeURIComponent(first.nextBefore!)}`)
    expect(second.messages).toHaveLength(1)
    expect(second.nextBefore).toBeNull()
    expect(new Set([...first.messages, ...second.messages].map((m) => m.id)).size).toBe(51)
  })

  it('orders ties by id and paginates across timestamps while new messages arrive', async () => {
    for (const [id, at] of [['a', 1000], ['b', 2000], ['c', 2000], ['d', 3000]] as const) await seedMessage(id, at)
    const first = await list('limit=2')
    expect(first.messages.map((m) => m.id)).toEqual(['d', 'c'])
    await seedMessage('new', 4000)
    const second = await list(`limit=2&before=${encodeURIComponent(first.nextBefore!)}`)
    expect(second.messages.map((m) => m.id)).toEqual(['b', 'a'])
    expect(second.nextBefore).toBeNull()
  })

  it('keeps legacy timestamp cursors working and applies channelGroup filters before the limit', async () => {
    await seedMessage('other', 3000, ['sent'], 'biz')
    await seedMessage('newer', 2000)
    await seedMessage('older', 1000)
    expect((await list('channelGroup=ops&limit=1')).messages.map((m) => m.id)).toEqual(['newer'])
    expect((await list('before=2000')).messages.map((m) => m.id)).toEqual(['older'])
  })

  it.each(['0', '-1', 'abc', '1000:', '1000:a:b', '9007199254740992'])('rejects invalid cursor %s', async (before) => {
    expect((await adminCall(`/messages?before=${encodeURIComponent(before)}`)).status).toBe(422)
  })
})

describe('message status filters', () => {
  it.each<MessageStatus>(['scheduled', 'pending', 'sent', 'partial', 'failed', 'canceled'])(
    'filters %s before pagination and keeps delivery counts', async (status) => {
      const now = Date.now()
      const states: Record<MessageStatus, DeliveryStatus[]> = {
        scheduled: ['scheduled'], pending: ['queued', 'scheduled'], sent: ['sent', 'sent'],
        partial: ['sent', 'failed'], failed: ['failed', 'canceled'], canceled: ['canceled'],
      }
      for (const [name, deliveries] of Object.entries(states)) {
        await seedMessage(`${name}-a`, now - 1000, deliveries, 'ops', now + 60_000)
        await seedMessage(`${name}-b`, now - 1000, deliveries, 'ops', now + 60_000)
      }
      const first = await list(`status=${status}&limit=1`)
      expect(first.messages).toHaveLength(1)
      expect(first.messages[0]).toMatchObject({ id: `${status}-b`, status, counts: { total: states[status].length } })
      const second = await list(`status=${status}&limit=1&before=${encodeURIComponent(first.nextBefore!)}`)
      expect(second.messages.map((m) => m.id)).toEqual([`${status}-a`])
      expect(second.nextBefore).toBeNull()
    },
  )
})
