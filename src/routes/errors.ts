import type { Context } from 'hono'
import { ForbiddenError, ValidationError } from '../domain/errors'
import { JSON_REQUEST_LIMIT } from '../shared/limits'

class RequestTooLargeError extends Error {}

export function handleError(err: Error, c: Context) {
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
    if (err instanceof RequestTooLargeError) throw err
    throw new ValidationError([{ path: '', message: '请求体必须是合法的 JSON' }])
  }
}

/** waitUntil of the current request, for work that outlives the response. */
export const waitUntilOf = (c: Context) => (p: Promise<unknown>) => c.executionCtx.waitUntil(p)
