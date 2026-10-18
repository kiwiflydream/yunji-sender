import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import { withTimeout } from '../lib/timeout'

/** Native, per-location protection: never consult D1 to decide admission. */
export async function enforceRateLimit(c: Context, binding: RateLimit, key: string): Promise<Response | null> {
  try {
    if ((await withTimeout(binding.limit({ key }), 1000)).success) return null
    c.header('retry-after', '60')
    c.header('cache-control', 'no-store')
    return c.json({ error: 'rate_limited' }, 429)
  } catch {
    // Missing/unavailable protection must not silently open the expensive path.
    c.header('retry-after', '60')
    c.header('cache-control', 'no-store')
    return c.json({ error: 'temporarily_unavailable' }, 503)
  }
}

export const limitIngress = (scope: 'api' | 'admin') => createMiddleware<{ Bindings: CloudflareBindings }>(async (c, next) => {
  // Cloudflare supplies this header. Do not trust client-controlled X-Forwarded-For.
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown'
  const individual = await enforceRateLimit(c, c.env.INBOUND_RATE_LIMIT, `${scope}:${ip}`)
  if (individual) return individual
  const total = await enforceRateLimit(c, c.env.INBOUND_TOTAL_LIMIT, scope)
  if (total) return total
  await next()
})
