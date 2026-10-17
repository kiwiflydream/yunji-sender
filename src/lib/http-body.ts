export const RESPONSE_BODY_LIMIT = 2 * 1024

/** Read at most `limit` bytes of the body as text, then cancel the rest. */
export async function readLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < limit) {
    const { done, value } = await reader.read()
    if (done) break
    const part = value.subarray(0, limit - size)
    chunks.push(part)
    size += part.byteLength
  }
  if (size >= limit) await reader.cancel().catch(() => {})
  const buf = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    buf.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder().decode(buf)
}

/** Truncate to `limit` UTF-8 bytes, dropping a split trailing character. */
export function truncateBytes(text: string, limit: number, marker = '…[truncated]'): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= limit) return text
  const room = Math.max(0, limit - new TextEncoder().encode(marker).length)
  return new TextDecoder().decode(bytes.subarray(0, room)).replace(/�$/, '') + marker
}

/** Truncate to `limit` UTF-16 code units (the unit most chat APIs count), without splitting a surrogate pair. */
export function truncateChars(text: string, limit: number, marker = '…'): string {
  if (text.length <= limit) return text
  let cut = Math.max(0, limit - marker.length)
  if (cut > 0 && /[\uD800-\uDBFF]/.test(text[cut - 1])) cut--
  return text.slice(0, cut) + marker
}
