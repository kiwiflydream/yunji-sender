import type { z } from 'zod'
import type { Issue } from '../shared/types'

export class ValidationError extends Error {
  constructor(readonly issues: Issue[]) {
    super(issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; '))
  }
}

export function zodIssues(error: z.ZodError): Issue[] {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
}

export function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new ValidationError(zodIssues(parsed.error))
  return parsed.data
}

/** The caller is authenticated but not allowed to do this (e.g. an API key limited to other channelGroups). */
export class ForbiddenError extends Error {}
