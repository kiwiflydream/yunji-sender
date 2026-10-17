import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach } from 'vitest'
import { putRuntimeSettings } from '../src/domain/settings'
import { DEFAULT_RUNTIME_SETTINGS } from '../src/shared/types'

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)

// D1 is isolated per file, not per test: reset state every test.
beforeEach(async () => {
  await env.DB.batch(
    ['deliveries', 'messages', 'topic_channels', 'topics', 'channels', 'api_keys', 'settings', 'delivery_stats_hourly'].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  )
  await putRuntimeSettings(env.DB, { ...DEFAULT_RUNTIME_SETTINGS, executionMode: 'queue' }, Date.now())
})
