import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { runMaintenance } from '../src/maintenance/maintenance'

it.each(['sent', 'scheduled'] as const)('does not scan unrelated %s deliveries during idle cron runs', async status => {
  const now = Date.now()
  await env.DB.prepare("INSERT INTO messages (id,source,payload,send_at,created_at) VALUES ('history','admin','{}',?,?)").bind(now, now).run()
  await env.DB.prepare(`WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<1000)
    INSERT INTO deliveries (id,message_id,channel_id,channel_type,channel_name,status,next_attempt_at,created_at,updated_at,deadline_at)
    SELECT 'd'||n,'history','c','webhook','c',?2,?1+604800000,?1,?1,?1+691200000 FROM nums`).bind(now, status).run()
  await env.DB.prepare(`WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<1000)
    INSERT INTO usage_counters (kind,scope,bucket,used) SELECT 'accepted-key-minute','s'||n,?1,1 FROM nums`).bind(now).run()
  const scans: { sql: string; rows: number }[] = []
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql)
      if (property === 'all' || property === 'run') return async () => {
        const result = await target[property]()
        scans.push({ sql, rows: result.meta.rows_read })
        return result
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const db = { prepare: (sql: string) => wrap(env.DB.prepare(sql), sql) }
  const executionEnv = Object.create(env, { DB: { value: db } }) as CloudflareBindings
  const report = await runMaintenance(executionEnv, () => {}, now)
  expect(report).toMatchObject({ dispatched: 0, revived: 0, expiredLeases: 0 })
  expect(scans.reduce((sum, scan) => sum + scan.rows, 0), JSON.stringify(scans)).toBeLessThan(100)
})
