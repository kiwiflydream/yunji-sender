/** Raw content may customize presentation, but never the saved channel's recipients. */
export function withoutRoutingFields(payload: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const blocked = new Set(fields)
  // Protocol field names are ASCII. Other runtimes can fold Unicode differently:
  // Go turns "devİce_key" into "device_key", unlike JavaScript.
  return Object.fromEntries(Object.entries(payload).filter(([key]) =>
    /^[\x00-\x7f]+$/.test(key) && !blocked.has(key.toLowerCase()),
  ))
}
