import { z } from 'zod'
import { DEFAULT_RUNTIME_SETTINGS, type RuntimeSettings } from '../shared/types'

export const runtimeSettingsSchema = z.object({
  sendingPaused: z.boolean(),
  dailyDeliveryLimit: z.number().int().min(1).max(1000000),
  perKeyDailyDeliveryLimit: z.number().int().min(1).max(1000000),
  perKeyMinuteLimit: z.number().int().min(1).max(100000),
  maxPendingDeliveries: z.number().int().min(1).max(100000),
  dailyWorkLimit: z.number().int().min(1).max(3000000),
  executionMode: z.enum(['queue', 'direct']),
  maxAttempts: z.number().int().min(1).max(10),
  retentionDays: z.number().int().min(1).max(3650),
  statsRetentionDays: z.number().int().min(1).max(3650),
})

/** Read at each boundary (request, queue message, cron) so saved changes apply without a redeploy. */
export async function getRuntimeSettings(db: D1Database): Promise<RuntimeSettings> {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'runtime'`).first<{ value: string }>()
  return row ? runtimeSettingsSchema.parse(JSON.parse(row.value)) : { ...DEFAULT_RUNTIME_SETTINGS }
}

export async function putRuntimeSettings(db: D1Database, settings: RuntimeSettings, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('runtime', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(settings), now)
    .run()
}
