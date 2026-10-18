/** Raw content may customize presentation, but never the saved channel's recipients. */
export function withoutRoutingFields(payload: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const blocked = new Set(fields)
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !blocked.has(key.toLowerCase())))
}
