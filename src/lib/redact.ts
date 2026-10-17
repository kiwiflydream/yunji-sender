/** Replace every occurrence of each secret (longest first) with ***. */
export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const s of [...secrets].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join('***')
  }
  return out
}
