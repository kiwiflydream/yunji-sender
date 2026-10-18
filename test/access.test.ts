import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { mockFetch, request } from './helpers'

afterEach(() => vi.restoreAllMocks())

let privateKey: CryptoKey
let jwk: JsonWebKey
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  privateKey = pair.privateKey
  jwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey
})
for (const scenario of ['valid', 'wrong-aud', 'wrong-iss', 'expired', 'tampered']) {
  it(`Access JWT verifies real RS256 signature: ${scenario}`, async () => {
    const team = `audit-${scenario}.cloudflareaccess.com`
    const now = Math.floor(Date.now() / 1000)
    const encode = (v: unknown) => base64url(new TextEncoder().encode(JSON.stringify(v)))
    const unsigned = encode({ alg: 'RS256', typ: 'JWT', kid: 'audit-key' }) + '.' + encode({
      iss: scenario === 'wrong-iss' ? 'https://other.cloudflareaccess.com' : `https://${team}`,
      aud: [scenario === 'wrong-aud' ? 'other-audience' : 'audit-audience'],
      email: 'audit@example.test', iat: now - 120, exp: scenario === 'expired' ? now - 60 : now + 600,
    })
    const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(unsigned)))
    if (scenario === 'tampered') signature[0] ^= 255
    const token = unsigned + '.' + base64url(signature)
    mockFetch(() => Response.json({ keys: [{ ...jwk, kid: 'audit-key', alg: 'RS256', use: 'sig' }] }))
    const bindings = Object.create(env, {
      ADMIN_AUTH_MODE: { value: 'access' }, ACCESS_TEAM_DOMAIN: { value: team }, ACCESS_AUD: { value: 'audit-audience' },
    }) as CloudflareBindings
    const res = await request('/admin/api/me', { headers: { 'cf-access-jwt-assertion': token } }, bindings)
    expect(res.status).toBe(scenario === 'valid' ? 200 : 403)
  })
}
