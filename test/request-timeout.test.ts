import { afterEach, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { handleError, jsonBody } from '../src/routes/errors'

afterEach(() => vi.useRealTimers())
const app = new Hono().onError(handleError).post('/', async c => c.json(await jsonBody(c.req.raw)))

it.each([false, true])('bounds the entire body read even with periodic chunks (trickle=%s)', async trickle => {
  vi.useFakeTimers()
  let close!: () => void
  let push!: () => void
  const cancel = vi.fn(() => new Promise<void>(() => {}))
  const body = new ReadableStream<Uint8Array>({
    start(c) { close = () => c.close(); push = () => c.enqueue(new TextEncoder().encode(' ')); push() },
    cancel,
  })
  let response: Response | undefined
  const task = Promise.resolve(app.request('http://test/', { method: 'POST', body })).then(r => { response = r })
  try {
    for (let i = 0; i < 9; i++) { await vi.advanceTimersByTimeAsync(1000); if (trickle) push() }
    expect(response).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1001)
    expect(response?.status).toBe(408)
    expect(await response?.json()).toEqual({ error: 'request_timeout' })
    expect(cancel).toHaveBeenCalledTimes(1)
  } finally {
    if (!cancel.mock.calls.length) close()
    await task
  }
})

it('accepts a complete streamed body before the deadline', async () => {
  const body = new ReadableStream<Uint8Array>({ start(c) {
    c.enqueue(new TextEncoder().encode('{"ok":')); c.enqueue(new TextEncoder().encode('true}')); c.close()
  } })
  const response = await app.request('http://test/', { method: 'POST', body })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
})
