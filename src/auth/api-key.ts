import { createMiddleware } from 'hono/factory'
import { verifyApiKey, type ApiCaller } from '../domain/api-keys'

export type ApiVariables = { caller: ApiCaller }

/** Bearer auth against the API keys managed in the admin UI. */
export const requireApiKey = createMiddleware<{ Bindings: CloudflareBindings; Variables: ApiVariables }>(async (c, next) => {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '')
  const caller = match ? await verifyApiKey(c.env.DB, match[1]) : null
  if (!caller) return c.json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' })
  c.set('caller', caller)
  await next()
})
