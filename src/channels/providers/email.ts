import { escapeHtml, markdownToHtml } from '../../lib/markdown'
import { postJson } from '../http'
import { plainText, subject, tagLine } from '../render'
import { str, type ChannelConfig, type ChannelProvider, type OutboundMessage } from '../types'

export const RESEND_API = 'https://api.resend.com/emails'
const LEVEL_TAG = { info: '', warn: '[警告] ', error: '[告警] ' } as const

export const splitAddresses = (s: string) =>
  s.split(/[,;\n]/).map((a) => a.trim()).filter(Boolean)

export function emailHtml(msg: OutboundMessage): string {
  const body = msg.format === 'markdown' ? markdownToHtml(msg.body) : `<p style="white-space:pre-wrap">${escapeHtml(msg.body)}</p>`
  return [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1f2328">',
    msg.title ? `<h2 style="margin:0 0 12px">${escapeHtml(msg.title)}</h2>` : '',
    body,
    msg.url ? `<p><a href="${escapeHtml(msg.url)}">${escapeHtml(msg.url)}</a></p>` : '',
    msg.tags.length ? `<p style="color:#59636e">${escapeHtml(tagLine(msg))}</p>` : '',
    '</div>',
  ].join('')
}

export function emailPayload(config: ChannelConfig, msg: OutboundMessage): Record<string, unknown> {
  const cc = splitAddresses(str(config, 'cc'))
  return {
    subject: LEVEL_TAG[msg.level] + subject(msg, 200),
    text: plainText(msg),
    html: emailHtml(msg),
    ...(cc.length ? { cc } : {}),
    ...(str(config, 'replyTo') ? { reply_to: str(config, 'replyTo') } : {}),
  }
}

export const emailProvider: ChannelProvider = {
  type: 'email',
  send(config, msg) {
    const routing = { from: str(config, 'from'), to: splitAddresses(str(config, 'to')) }
    const payload = msg.raw ? { ...routing, ...msg.raw } : { ...routing, ...emailPayload(config, msg) }
    return postJson(RESEND_API, payload, {
      authorization: `Bearer ${str(config, 'apiKey')}`,
      // Resend deduplicates for 24 h, so a retry after a lost response never sends twice.
      'idempotency-key': msg.deliveryId,
    })
  },
}
