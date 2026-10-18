import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { adminCall, apiCall } from './helpers'

it.each(['api','admin'])('rejects exhausted %s ingress before touching D1', async scope => {
  const prepare = vi.fn(() => { throw new Error('must not query DB') })
  const limit = vi.fn(async () => ({ success: false }))
  const e = Object.create(env, { DB: { value: { prepare } }, INBOUND_RATE_LIMIT: { value: { limit } } }) as CloudflareBindings
  const response = scope === 'api'
    ? await apiCall('cfs_'+'a'.repeat(32), '/messages/missing', {}, e)
    : await adminCall('/me', {}, e)
  expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBe('60')
  expect(prepare).not.toHaveBeenCalled()
})

it('rejects malformed keys without a D1 lookup', async () => {
  const prepare = vi.fn(() => { throw new Error('must not query DB') })
  const e = Object.create(env, { DB: { value: { prepare } } }) as CloudflareBindings
  expect((await apiCall('cfs_invalid', '/messages/missing', {}, e)).status).toBe(401)
  expect(prepare).not.toHaveBeenCalled()
})

it('shares a total budget across IPs and returns 503 when protection is unavailable', async () => {
  const prepare = vi.fn(() => { throw new Error('must not query DB') })
  const allow = { limit: async () => ({ success: true }) }
  for (const limit of [async () => ({ success: false }), async () => { throw new Error('unavailable') }]) {
    const e = Object.create(env, { DB: { value: { prepare } }, INBOUND_RATE_LIMIT: { value: allow }, INBOUND_TOTAL_LIMIT: { value: { limit } } }) as CloudflareBindings
    const r = await apiCall('cfs_'+'a'.repeat(32), '/messages/missing', {}, e)
    expect([429,503]).toContain(r.status)
  }
  expect(prepare).not.toHaveBeenCalled()
})

it('does not let changing credentials, paths or X-Forwarded-For split the IP bucket', async () => {
  const limit = vi.fn(async () => ({ success: false }))
  const e = Object.create(env, { INBOUND_RATE_LIMIT: { value: { limit } } }) as CloudflareBindings
  for (let i=0;i<3;i++) await apiCall('cfs_'+String(i).repeat(32), '/messages/id'+i, {
    headers: { 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-for': '192.0.2.'+(i+2) },
  }, e)
  expect(limit.mock.calls).toEqual(Array.from({length:3},()=>[{key:'api:192.0.2.1'}]))
})
