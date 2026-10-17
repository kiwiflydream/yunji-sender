import type { Context } from 'hono'
import { ForbiddenError, ValidationError } from '../domain/errors'

export function handleError(err: Error, c: Context) {
  if (err instanceof ValidationError) return c.json({ error: 'validation_failed', issues: err.issues }, 422)
  if (err instanceof ForbiddenError) return c.json({ error: 'forbidden', message: err.message }, 403)
  console.error('api error', err)
  return c.json({ error: 'internal_error' }, 500)
}

export async function jsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw new ValidationError([{ path: '', message: '请求体必须是合法的 JSON' }])
  }
}

/** waitUntil of the current request, for work that outlives the response. */
export const waitUntilOf = (c: Context) => (p: Promise<unknown>) => c.executionCtx.waitUntil(p)
