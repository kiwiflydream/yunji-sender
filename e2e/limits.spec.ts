import { expect, test } from '@playwright/test'
import { baseURL } from './helpers'

// Runs last: exercising the shared stats budget deliberately exhausts it.
test('native ingress and statistics bindings reject excess traffic', async () => {
  let limited = false
  for (let i=0;i<330;i++) {
    const response = await fetch(`${baseURL}/api/messages/missing`, { headers: {
      authorization: 'Bearer cfs_invalid', 'cf-connecting-ip': '192.0.2.199',
    } })
    await response.text()
    if (response.status === 429) { limited = true; expect(response.headers.get('retry-after')).toBe('60'); break }
    expect(response.status).toBe(401)
  }
  expect(limited).toBe(true)
  const other = await fetch(`${baseURL}/api/messages/missing`, { headers: {
    authorization: 'Bearer cfs_invalid', 'cf-connecting-ip': '192.0.2.198',
  } })
  await other.text()
  expect(other.status).toBe(401)
  limited = false
  for (let i=0;i<40;i++) {
    const response = await fetch(`${baseURL}/admin/api/stats?range=24h`, { headers: {
      authorization: `Basic ${Buffer.from(`admin:${process.env.E2E_ADMIN_PASSWORD}`).toString('base64')}`,
      'cf-connecting-ip': '192.0.2.197',
    } })
    await response.text()
    if (response.status === 429) { limited = true; break }
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
  }
  expect(limited).toBe(true)
})
