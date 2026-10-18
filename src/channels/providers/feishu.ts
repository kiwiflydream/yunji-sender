import { hmacSha256, toBase64 } from '../../lib/hmac'
import { invalidSuccessResponse, postJson } from '../http'
import { footerLines, headline, joinSections, plainText } from '../render'
import { str, type ChannelProvider, type OutboundMessage } from '../types'

const TEMPLATE = { info: 'blue', warn: 'orange', error: 'red' } as const
/** Frequency-limit codes of custom bots. */
const RATE_LIMIT_CODES = new Set([9499, 11232])

/** timestamp + sign: HMAC-SHA256 keyed by "timestamp\nsecret" over an empty message. */
export async function feishuSign(secret: string, timestampSec: number) {
  const timestamp = String(timestampSec)
  return { timestamp, sign: toBase64(await hmacSha256(`${timestamp}\n${secret}`, '')) }
}

export function feishuPayload(msg: OutboundMessage): Record<string, unknown> {
  if (msg.format !== 'markdown') return { msg_type: 'text', content: { text: plainText(msg) } }
  const title = headline(msg)
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      ...(title ? { header: { title: { tag: 'plain_text', content: title }, template: TEMPLATE[msg.level] } } : {}),
      elements: [{ tag: 'markdown', content: joinSections(msg.body, footerLines(msg, (u) => `[${u}](${u})`).join('\n')) }],
    },
  }
}

export const feishuProvider: ChannelProvider = {
  type: 'feishu',
  async send(config, msg) {
    const secret = str(config, 'signSecret')
    const signing = secret ? await feishuSign(secret, Math.floor(Date.now() / 1000)) : {}
    const payload = { ...(msg.raw ?? feishuPayload(msg)), ...signing }
    return postJson(str(config, 'webhookUrl'), payload, {}, (json, status) => {
      const code = json?.code ?? json?.StatusCode
      if (typeof code !== 'number') return invalidSuccessResponse('飞书', status)
      if (code === 0) return null
      return { error: `飞书返回 ${code}: ${json?.msg ?? json?.StatusMessage ?? ''}`.trim(), retryable: RATE_LIMIT_CODES.has(code) }
    })
  },
}
