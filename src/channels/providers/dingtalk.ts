import { hmacSha256, toBase64 } from '../../lib/hmac'
import { postJson } from '../http'
import { footerLines, headline, joinSections, plainText, subject } from '../render'
import { str, type ChannelProvider, type OutboundMessage } from '../types'

/** "send too fast": more than 20 messages per minute. */
const RATE_LIMIT_CODE = 130101

/** Append timestamp + sign: base64(HMAC-SHA256(secret, "timestamp\nsecret")). */
export async function dingtalkSignedUrl(webhookUrl: string, secret: string, timestampMs: number): Promise<string> {
  const url = new URL(webhookUrl)
  url.searchParams.set('timestamp', String(timestampMs))
  url.searchParams.set('sign', toBase64(await hmacSha256(secret, `${timestampMs}\n${secret}`)))
  return url.toString()
}

export function dingtalkPayload(msg: OutboundMessage): Record<string, unknown> {
  if (msg.format !== 'markdown') return { msgtype: 'text', text: { content: plainText(msg) } }
  const title = headline(msg)
  return {
    msgtype: 'markdown',
    markdown: {
      title: subject(msg, 64),
      text: joinSections(title && `### ${title}`, msg.body, footerLines(msg, (u) => `[${u}](${u})`).join('\n')),
    },
  }
}

export const dingtalkProvider: ChannelProvider = {
  type: 'dingtalk',
  async send(config, msg) {
    const secret = str(config, 'signSecret')
    const url = secret ? await dingtalkSignedUrl(str(config, 'webhookUrl'), secret, Date.now()) : str(config, 'webhookUrl')
    return postJson(url, msg.raw ?? dingtalkPayload(msg), {}, (json) =>
      json?.errcode === 0 || json?.errcode === undefined
        ? null
        : { error: `钉钉返回 ${json.errcode}: ${json.errmsg ?? ''}`.trim(), retryable: json.errcode === RATE_LIMIT_CODE },
    )
  },
}
