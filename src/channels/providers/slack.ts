import { truncateChars } from '../../lib/http-body'
import { markdownToSlack } from '../../lib/markdown'
import { postJson } from '../http'
import { headline, plainText, tagLine } from '../render'
import { str, type ChannelProvider, type OutboundMessage } from '../types'

const escapeSlack = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function slackPayload(msg: OutboundMessage): Record<string, unknown> {
  const title = headline(msg)
  const body = msg.format === 'markdown' ? markdownToSlack(msg.body) : escapeSlack(msg.body)
  const blocks: unknown[] = []
  if (title) blocks.push({ type: 'header', text: { type: 'plain_text', text: truncateChars(title, 150), emoji: true } })
  if (body) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: truncateChars(body, 3000) } })
  const context = [msg.url && `<${msg.url}>`, msg.tags.length && escapeSlack(tagLine(msg))].filter(Boolean) as string[]
  if (context.length) blocks.push({ type: 'context', elements: context.map((text) => ({ type: 'mrkdwn', text })) })
  // `text` is the notification / fallback.
  return { text: truncateChars(plainText(msg), 3000), blocks }
}

export const slackProvider: ChannelProvider = {
  type: 'slack',
  send: (config, msg) => postJson(str(config, 'webhookUrl'), msg.raw ?? slackPayload(msg)),
}
