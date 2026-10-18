import { StatsCacheBusyError } from '../domain/stats-cache'
import type { Context } from 'hono'
import { ForbiddenError, ValidationError } from '../domain/errors'
import { JSON_REQUEST_LIMIT } from '../shared/limits'
import { resumeAt, safetyCode } from '../domain/safety'
import { OperationTimeoutError, withTimeout } from '../lib/timeout'

class RequestTooLargeError extends Error {}
class RequestBodyTimeoutError extends Error {}
const REQUEST_BODY_TIMEOUT_MS = 10_000

export function handleError(err: Error, c: Context) {
  if (err instanceof StatsCacheBusyError) {
    c.header('retry-after', '10')
    return c.json({ error: 'temporarily_unavailable' }, 503)
  }
  if (err instanceof RequestBodyTimeoutError) return c.json({ error: 'request_timeout' }, 408)
  const code = safetyCode(err)
  if (code) {
    const now = Date.now()
    c.header('retry-after', String(Math.ceil((resumeAt(code, now) - now) / 1000)))
    return c.json({ error: 'safety_limit', reason: code }, code === 'paused' ? 503 : 429)
  }
  if (err instanceof RequestTooLargeError) return c.json({ error: 'payload_too_large', maxBytes: JSON_REQUEST_LIMIT }, 413)
  if (err instanceof ValidationError) return c.json({ error: 'validation_failed', issues: err.issues }, 422)
  if (err instanceof ForbiddenError) return c.json({ error: 'forbidden', message: err.message }, 403)
  console.error('api error', err)
  return c.json({ error: 'internal_error' }, 500)
}

export async function jsonBody(req: Request): Promise<unknown> {
  try {
    const declared = req.headers.get('content-length')
    if (declared && /^\d+$/.test(declared) && Number(declared) > JSON_REQUEST_LIMIT) {
      void req.body?.cancel().catch(() => {})
      throw new RequestTooLargeError()
    }
    if (!req.body) throw new Error('empty body')
    const reader = req.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      await withTimeout((async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > JSON_REQUEST_LIMIT) {
            void reader.cancel().catch(() => {})
            throw new RequestTooLargeError()
          }
          chunks.push(value)
        }
      })(), REQUEST_BODY_TIMEOUT_MS, () => { void reader.cancel().catch(() => {}) })
    } finally {
      reader.releaseLock()
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch (err) {
    if (err instanceof OperationTimeoutError) throw new RequestBodyTimeoutError()
    if (err instanceof RequestTooLargeError) throw err
    throw new ValidationError([{ path: '', message: '请求体必须是合法的 JSON' }])
  }
}

/** waitUntil of the current request, for work that outlives the response. */
export const waitUntilOf = (c: Context) => (p: Promise<unknown>) => c.executionCtx.waitUntil(p)
