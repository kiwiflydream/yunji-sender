import { RESPONSE_BODY_LIMIT, truncateBytes } from './http-body'

/** Include individual credentials when a secret field contains headers or a credential-bearing URL. */
export function collectSecretValues(secrets: Record<string, string>): string[] {
  const values = new Set(Object.values(secrets).filter(Boolean))
  for (const value of Object.values(secrets)) {
    try {
      const url = new URL(value)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        for (const part of [url.username, url.password]) {
          if (!part) continue
          values.add(part)
          try { values.add(decodeURIComponent(part)) } catch { /* Keep malformed escapes literal. */ }
        }
        for (const part of url.searchParams.values()) if (part) values.add(part)
      }
    } catch { /* Most secret fields are tokens, not URLs. */ }
  }
  if (secrets.headers) {
    const headers = JSON.parse(secrets.headers) as Record<string, string>
    for (const [name, value] of Object.entries(headers)) {
      if (!value) continue
      values.add(value)
      values.add(value.trim()) // Headers normalizes surrounding HTTP whitespace before sending.
      if (/^(?:proxy-)?authorization$/i.test(name)) {
        const auth = /^\S+\s+(.+)$/.exec(value.trim())
        if (auth) values.add(auth[1])
        if (/^Basic\s/i.test(value.trim()) && auth) {
          try {
            const decoded = atob(auth[1])
            values.add(decoded)
            const password = decoded.slice(decoded.indexOf(':') + 1)
            if (password) values.add(password)
          } catch { /* Preserve the original value for malformed credentials. */ }
        }
      }
      if (/^cookie$/i.test(name)) {
        for (const part of value.split(';')) {
          const equals = part.indexOf('=')
          if (equals >= 0 && part.slice(equals + 1).trim()) values.add(part.slice(equals + 1).trim())
        }
      }
    }
  }
  return [...values]
}

/** Replace raw, JSON-escaped and URL-encoded credentials, longest first. */
export function redact(text: string, secrets: string[]): string {
  let out = text
  const encoded = secrets.filter(Boolean).flatMap((s) => [
    s, JSON.stringify(s).slice(1, -1), encodeURIComponent(s.toWellFormed()), new URLSearchParams({ v: s }).toString().slice(2),
  ])
  const variants = new Set(encoded.flatMap((s) => [s, s.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase())]))
  for (const s of [...variants].sort((a, b) => b.length - a.length)) {
    out = out.split(s).join('***')
  }
  return out
}

/** Sanitize before truncation so a credential crossing the size limit cannot leak a prefix. */
export const redactResponse = (text: string | null, secrets: string[]): string | null =>
  text === null ? null : truncateBytes(redact(text, secrets), RESPONSE_BODY_LIMIT)
