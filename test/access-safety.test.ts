import { afterEach, expect, it, vi } from 'vitest'
import { verifyAccessJwt } from '../src/auth/access'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it('coalesces concurrent certificate requests and cools down failures', async () => {
  vi.useFakeTimers()
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 503 }))
  const team = 'safety-concurrent.cloudflareaccess.com'
  await Promise.all(Array.from({ length: 10 }, () => verifyAccessJwt('bad', team, 'aud')))
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(await verifyAccessJwt('bad', team, 'aud')).toBe(null)
  expect(fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(60_001)
  await verifyAccessJwt('bad', team, 'aud')
  expect(fetch).toHaveBeenCalledTimes(2)
})

it.each(['headers', 'body'])('times out stalled certificate %s and cancels the request', async (stage) => {
  vi.useFakeTimers()
  let release!: () => void
  const response = stage === 'body' ? new Response(new ReadableStream({ start(c) { release = () => c.close() } })) : undefined
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => stage === 'body'
    ? Promise.resolve(response!) : new Promise(resolve => { release = () => resolve(Response.json({ keys: [] })) }))
  let settled = false
  const task = verifyAccessJwt('bad', `safety-${stage}.cloudflareaccess.com`, 'aud').then(value => { settled = true; return value })
  try {
    await vi.advanceTimersByTimeAsync(5001)
    expect(settled).toBe(true)
    expect(await task).toBe(null)
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally {
    release()
    await task
  }
})
