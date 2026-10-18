import type { TemplateVariables } from './types'
import { utf8ByteLength } from './limits'

const PLACEHOLDER = /{{\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*}}/g

export function templateVariables(content: { title: string; body: string }): string[] {
  return [...new Set([...`${content.title}\n${content.body}`.matchAll(PLACEHOLDER)].map((m) => m[1]))]
}

export function validTemplateText(text: string): boolean {
  return !/{{|}}/.test(text.replace(PLACEHOLDER, '')) && !/{{{|}}}/.test(text)
}

/** Calculate before allocating the rendered result, so repeated variables stay bounded. */
export function renderedTemplateLength(text: string, values: TemplateVariables): number {
  let length = text.length
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (Object.hasOwn(values, match[1])) length += String(values[match[1]]).length - match[0].length
  }
  return length
}

/** Measure the rendered UTF-8 text without allocating an expanded body. */
export function renderedTemplateByteLength(text: string, values: TemplateVariables, limit = Infinity): number {
  let bytes = 0
  let endsWithHighSurrogate = false
  const append = (part: string) => {
    if (!part) return
    bytes += utf8ByteLength(part)
    // Replacement can join surrogate halves that were separated by a token.
    if (endsWithHighSurrogate && /^[\uDC00-\uDFFF]/.test(part)) bytes -= 2
    endsWithHighSurrogate = /[\uD800-\uDBFF]$/.test(part)
  }
  let offset = 0
  for (const match of text.matchAll(PLACEHOLDER)) {
    append(text.slice(offset, match.index))
    if (bytes > limit) return bytes
    const value = Object.hasOwn(values, match[1]) ? String(values[match[1]]) : ''
    append(value.trim() ? value : match[0])
    if (bytes > limit) return bytes
    offset = match.index + match[0].length
  }
  append(text.slice(offset))
  return bytes
}

/** One pass only: variable values are text, never more template syntax or code. */
export function renderTemplate(content: { title: string; body: string }, values: TemplateVariables) {
  const missing = templateVariables(content).filter((key) => !Object.hasOwn(values, key) || String(values[key]).trim() === '')
  const replace = (text: string) => text.replace(PLACEHOLDER, (token, key: string) =>
    Object.hasOwn(values, key) && String(values[key]).trim() !== '' ? String(values[key]) : token,
  )
  return { title: replace(content.title), body: replace(content.body), missing }
}
