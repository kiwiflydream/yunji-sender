const DAY_MS = 86400000
export type SafetyCode = 'paused' | 'daily' | 'key_daily' | 'rate' | 'backlog' | 'work'

export function safetyCode(error: unknown): SafetyCode | null {
  return /safety:(paused|daily|key_daily|rate|backlog|work)\b/.exec(String(error))?.[1] as SafetyCode | undefined ?? null
}

export function resumeAt(code: SafetyCode, now: number): number {
  return code === 'daily' || code === 'key_daily' || code === 'work'
    ? now - now % DAY_MS + DAY_MS : now + 5 * 60_000
}

/** Channel tests use the same atomic work budget as normal delivery attempts. */
export async function reserveWork(db: D1Database, now: number): Promise<void> {
  await db.prepare(`INSERT INTO usage_counters (kind, scope, bucket, used) VALUES ('work', '*', ?, 1)
    ON CONFLICT (kind, scope, bucket) DO UPDATE SET used = used + excluded.used`)
    .bind(now - now % DAY_MS).run()
}

/** Park queued work on a budget failure; acknowledge the queue message instead of retrying it. */
export async function parkDeliveries(db: D1Database, items: { id: string; attempts: number }[], code: SafetyCode, now: number): Promise<void> {
  await db.prepare(`UPDATE deliveries SET status='scheduled', dispatch_after=?1, updated_at=?2, error=?3
    WHERE (id, attempts) IN (SELECT json_extract(value, '$.id'), json_extract(value, '$.attempts') FROM json_each(?4))
      AND status IN ('scheduled','queued')`)
    .bind(resumeAt(code, now), now, `safety:${code}`, JSON.stringify(items)).run()
}
