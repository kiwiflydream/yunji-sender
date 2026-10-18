import { withTimeout } from '../lib/timeout'
import { readLimited } from '../lib/http-body'
import type { HonoJsonWebKey } from 'hono/utils/jwt/jws'
import { verifyWithJwks } from 'hono/utils/jwt/jwt'

const JWKS_TTL_MS = 10 * 60_000
/** Bad tokens trigger a refresh; rate-limit it so they cannot force a fetch per request. */
const JWKS_MIN_REFRESH_MS = 60_000
interface KeyCache {
  keys?: HonoJsonWebKey[]
  fetchedAt: number
  retryAt: number
  inFlight?: Promise<HonoJsonWebKey[]>
}
const jwksCache = new Map<string, KeyCache>()
export const ACCESS_FETCH_TIMEOUT_MS = 5000

async function fetchKeys(teamDomain: string): Promise<HonoJsonWebKey[]> {
  const controller = new AbortController()
  return withTimeout((async () => {
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: controller.signal, redirect: 'manual' })
    if (!res.ok) { void res.body?.cancel().catch(() => {}); throw new Error('Access cert request failed') }
    const data = JSON.parse(await readLimited(res, 64 * 1024))
    if (!Array.isArray(data?.keys) || data.keys.length > 100) throw new Error('Invalid Access cert response')
    return data.keys as HonoJsonWebKey[]
  })(), ACCESS_FETCH_TIMEOUT_MS, () => controller.abort())
}

async function accessKeys(teamDomain: string, forceRefresh = false): Promise<HonoJsonWebKey[]> {
  const now = Date.now()
  const cached = jwksCache.get(teamDomain) ?? { fetchedAt: 0, retryAt: 0 }
  if (cached.keys && now - cached.fetchedAt < (forceRefresh ? JWKS_MIN_REFRESH_MS : JWKS_TTL_MS)) return cached.keys
  if (cached.inFlight) return cached.inFlight
  if (now < cached.retryAt) throw new Error('Access cert refresh cooling down')
  jwksCache.set(teamDomain, cached)
  cached.retryAt = now + JWKS_MIN_REFRESH_MS
  cached.inFlight = fetchKeys(teamDomain).then((keys) => {
    cached.keys = keys
    cached.fetchedAt = Date.now()
    return keys
  }).catch((error) => {
    cached.retryAt = Date.now() + JWKS_MIN_REFRESH_MS
    throw error
  }).finally(() => { cached.inFlight = undefined })
  return cached.inFlight
}

/**
 * Verify a Cloudflare Access JWT (from the `cf-access-jwt-assertion` header or
 * the `CF_Authorization` cookie). Returns the user's email, or null if invalid.
 */
export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string,
): Promise<string | null> {
  const verify = async (forceRefresh: boolean) =>
    verifyWithJwks(token, {
      keys: await accessKeys(teamDomain, forceRefresh),
      allowedAlgorithms: ['RS256'],
      verification: { iss: `https://${teamDomain}`, aud },
    })
  let payload
  try {
    payload = await verify(false)
  } catch {
    try {
      // Keys may have rotated since we cached them.
      payload = await verify(true)
    } catch {
      return null
    }
  }
  return typeof payload.email === 'string' ? payload.email : 'unknown'
}
