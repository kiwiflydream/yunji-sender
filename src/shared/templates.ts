import type { TemplateVariables } from './types'

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

/** One pass only: variable values are text, never more template syntax or code. */
export function renderTemplate(content: { title: string; body: string }, values: TemplateVariables) {
  const missing = templateVariables(content).filter((key) => !Object.hasOwn(values, key) || String(values[key]).trim() === '')
  const replace = (text: string) => text.replace(PLACEHOLDER, (token, key: string) =>
    Object.hasOwn(values, key) && String(values[key]).trim() !== '' ? String(values[key]) : token,
  )
  return { title: replace(content.title), body: replace(content.body), missing }
}
