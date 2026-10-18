import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach } from 'vitest'
import { putRuntimeSettings } from '../src/domain/settings'
import { DEFAULT_RUNTIME_SETTINGS } from '../src/shared/types'

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
const defaultTemplates = (await env.DB.prepare('SELECT * FROM message_templates').all<Record<string, string | number | null>>()).results

// D1 is isolated per file, not per test: reset state every test.
beforeEach(async () => {
  await env.DB.batch(
    ['deliveries', 'messages', 'channel_group_channels', 'channel_groups', 'channels', 'api_keys', 'settings', 'delivery_stats', 'message_templates'].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  )
  await env.DB.batch(defaultTemplates.map((row) => env.DB.prepare('INSERT INTO message_templates (id, name, description, content, channel_group_slug, channel_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.name, row.description, row.content, row.channel_group_slug, row.channel_ids, row.created_at, row.updated_at)))
  await putRuntimeSettings(env.DB, { ...DEFAULT_RUNTIME_SETTINGS, executionMode: 'queue' }, Date.now())
})
