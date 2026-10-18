import { truncateChars } from '../../lib/http-body'
import { escapeHtml, markdownToTelegramHtml } from '../../lib/markdown'
import { invalidSuccessResponse, postJson } from '../http'
import { footerLines, headline, joinSections, plainText } from '../render'
import { str, type ChannelProvider, type OutboundMessage } from '../types'

/** sendMessage text limit (UTF-16 units, after entity parsing; we count the markup too, conservatively). */
export const TELEGRAM_TEXT_LIMIT = 4096

export function telegramText(msg: OutboundMessage): { text: string; parse_mode?: 'HTML' } {
  const title = headline(msg)
  const html = joinSections(
    title && `<b>${escapeHtml(title)}</b>`,
    msg.format === 'markdown' ? markdownToTelegramHtml(msg.body) : escapeHtml(msg.body),
    footerLines(msg, (u) => `<a href="${escapeHtml(u)}">${escapeHtml(u)}</a>`, escapeHtml).join('\n'),
  )
  // Cutting HTML could leave an unclosed tag, which Telegram rejects: fall back to plain text.
  if (html.length <= TELEGRAM_TEXT_LIMIT) return { text: html, parse_mode: 'HTML' }
  return { text: truncateChars(plainText(msg), TELEGRAM_TEXT_LIMIT) }
}

export const telegramProvider: ChannelProvider = {
  type: 'telegram',
  async send(config, msg) {
    const base = (str(config, 'apiBase') || 'https://api.telegram.org').replace(/\/+$/, '')
    const routing: Record<string, unknown> = { chat_id: str(config, 'chatId') }
    const thread = str(config, 'messageThreadId')
    if (thread) routing.message_thread_id = Number(thread)
    const payload = msg.raw
      ? { ...msg.raw, ...routing }
      : {
          ...routing,
          ...telegramText(msg),
          link_preview_options: { is_disabled: true },
          disable_notification: config.silent === true,
        }
    return postJson(`${base}/bot${str(config, 'botToken')}/sendMessage`, payload, {}, (json, status) => {
      if (typeof json?.ok !== 'boolean') return invalidSuccessResponse('Telegram', status)
      return json.ok === true
        ? null
        : {
            error: String(json?.description ?? 'Telegram API returned ok=false'),
            retryable: json?.error_code === 429,
            retryAfterMs: typeof json?.parameters?.retry_after === 'number' ? json.parameters.retry_after * 1000 : null,
          }
    })
  },
}
