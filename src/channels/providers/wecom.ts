import { truncateBytes } from '../../lib/http-body'
import { postJson } from '../http'
import { footerLines, headline, joinSections, plainText } from '../render'
import { str, type ChannelProvider, type OutboundMessage } from '../types'

/** Byte limits of the group bot API. */
const MARKDOWN_LIMIT = 4096
const TEXT_LIMIT = 2048

export function wecomPayload(msg: OutboundMessage): Record<string, unknown> {
  if (msg.format !== 'markdown') {
    return { msgtype: 'text', text: { content: truncateBytes(plainText(msg), TEXT_LIMIT, '…') } }
  }
  const title = headline(msg)
  const content = joinSections(title && `## ${title}`, msg.body, footerLines(msg, (u) => `[${u}](${u})`).join('\n'))
  return { msgtype: 'markdown', markdown: { content: truncateBytes(content, MARKDOWN_LIMIT, '…') } }
}

export const wecomProvider: ChannelProvider = {
  type: 'wecom',
  async send(config, msg) {
    return postJson(str(config, 'webhookUrl'), msg.raw ?? wecomPayload(msg), {}, (json) =>
      json?.errcode === 0 || json?.errcode === undefined
        ? null
        : { error: `企业微信返回 ${json.errcode}: ${json.errmsg ?? ''}`.trim(), retryable: json.errcode === 45009 },
    )
  },
}
