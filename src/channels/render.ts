import { markdownToPlain } from '../lib/markdown'
import type { MessageLevel } from '../shared/types'
import type { OutboundMessage } from './types'

const LEVEL_PREFIX: Record<MessageLevel, string> = { info: '', warn: '⚠️ ', error: '🚨 ' }

/** Title with a level marker for chat channels; '' when the message has no title. */
export function headline(msg: OutboundMessage): string {
  return msg.title ? LEVEL_PREFIX[msg.level] + msg.title : ''
}

/** Body as plain text: Markdown markers removed when the message is Markdown. */
export function plainBody(msg: OutboundMessage): string {
  return msg.format === 'markdown' ? markdownToPlain(msg.body) : msg.body
}

export const tagLine = (msg: OutboundMessage) => msg.tags.map((t) => `#${t}`).join(' ')

/** URL and tags as trailing lines, each line already in the target syntax. */
export function footerLines(msg: OutboundMessage, link: (url: string) => string = (u) => u, tags: (s: string) => string = (s) => s): string[] {
  const lines: string[] = []
  if (msg.url) lines.push(link(msg.url))
  if (msg.tags.length) lines.push(tags(tagLine(msg)))
  return lines
}

export const joinSections = (...parts: (string | null | undefined | false)[]) =>
  parts.filter((p): p is string => typeof p === 'string' && p !== '').join('\n\n')

/** The whole message as one plain-text block. */
export function plainText(msg: OutboundMessage): string {
  return joinSections(headline(msg), plainBody(msg), footerLines(msg).join('\n'))
}

/** Email subject / notification title: the title, else the first body line. */
export function subject(msg: OutboundMessage, max = 120): string {
  const s = msg.title || plainBody(msg).split('\n').find((l) => l.trim())?.trim() || '(no subject)'
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
