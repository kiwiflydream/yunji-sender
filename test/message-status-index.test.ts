import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { getMessage, listMessages } from '../src/domain/messages'
import type { DeliveryStatus, MessageStatus } from '../src/shared/types'

const states: Record<MessageStatus, DeliveryStatus[]> = {
  scheduled: ['scheduled'], pending: ['queued', 'scheduled'], sent: ['sent'],
  partial: ['sent', 'failed'], failed: ['failed', 'canceled'], canceled: ['canceled'],
}

it.each(Object.keys(states) as MessageStatus[])('finds sparse %s messages without reading unrelated history', async status => {
  const now = Date.now()
  await env.DB.prepare(`WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<1000)
    INSERT INTO messages (id,source,payload,send_at,created_at,channel_group_slug)
    SELECT 'm'||n,'admin','{}',?1,?1+n,'ops' FROM nums`).bind(now).run()
  await env.DB.prepare(`INSERT INTO deliveries (id,message_id,channel_id,channel_type,channel_name,status,next_attempt_at,created_at,updated_at,deadline_at)
    SELECT id,id,'c','webhook','c',?1,?2,?2,?2,?2+86400000 FROM messages`).bind(status === 'sent' ? 'failed' : 'sent', now).run()
  await env.DB.prepare("INSERT INTO messages (id,source,payload,send_at,created_at,channel_group_slug) VALUES ('target','admin','{}',?,?, 'ops')").bind(now + 60000, now - 1).run()
  for (const [i, state] of states[status].entries()) {
    await env.DB.prepare(`INSERT INTO deliveries (id,message_id,channel_id,channel_type,channel_name,status,next_attempt_at,created_at,updated_at,deadline_at)
      VALUES (?1,'target','c','webhook','c',?2,?3,?3,?3,?3+86400000)`).bind('target'+i, state, now).run()
  }
  const reads: number[] = []
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args))
      if (property === 'all') return async () => { const result = await target.all(); reads.push(result.meta.rows_read); return result }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const db = { prepare: (sql: string) => wrap(env.DB.prepare(sql)) } as D1Database
  for (const channelGroup of [undefined, 'ops']) {
    const result = await listMessages(db, { limit: 10, status, channelGroup }, now)
    expect(result.messages.map(m => m.id)).toEqual(['target'])
    expect(result.messages[0].status).toBe(status)
  }
  expect(Math.max(...reads)).toBeLessThan(100)
})

it('keeps filtered status consistent through updates, deletes and the scheduled time boundary', async () => {
  const now = Date.now()
  await env.DB.prepare("INSERT INTO messages (id,source,payload,send_at,created_at) VALUES ('m','admin','{}',?,?)").bind(now + 1000, now).run()
  for (const id of ['a','b']) await env.DB.prepare(`INSERT INTO deliveries (id,message_id,channel_id,channel_type,channel_name,status,next_attempt_at,created_at,updated_at,deadline_at)
    VALUES (?1,'m','c','webhook','c','scheduled',?2,?2,?2,?2+86400000)`).bind(id, now).run()
  const check = async (at: number) => {
    const detail = (await getMessage(env.DB, 'm', at))!
    for (const status of Object.keys(states) as MessageStatus[]) {
      const result = await listMessages(env.DB, { status, limit: 10 }, at)
      expect(result.messages.map(m => m.id)).toEqual(detail.status === status ? ['m'] : [])
    }
  }
  await check(now)
  await check(now + 1000)
  for (const state of ['sending','failed','queued','sent','canceled'] as const) {
    await env.DB.prepare('UPDATE deliveries SET status=? WHERE id=?').bind(state,'a').run()
    await check(now)
  }
  await env.DB.prepare("UPDATE deliveries SET status='failed' WHERE id='b'").run()
  await check(now)
  await env.DB.prepare("DELETE FROM deliveries WHERE id='b'").run()
  await check(now)
  await env.DB.prepare("DELETE FROM messages WHERE id='m'").run()
  expect((await listMessages(env.DB,{limit:10},now)).messages).toEqual([])
})
