import { hmacSha256, toHex } from '../../lib/hmac'
import { deliverHttp } from '../http'
import { str, type ChannelProvider } from '../types'

export const webhookProvider: ChannelProvider = {
  type: 'webhook',
  async send(config, msg) {
    const body = JSON.stringify(
      msg.raw ?? {
        id: msg.messageId,
        deliveryId: msg.deliveryId,
        channelGroup: msg.channelGroup,
        title: msg.title,
        body: msg.body,
        format: msg.format,
        level: msg.level,
        url: msg.url,
        tags: msg.tags,
        createdAt: new Date(msg.createdAt).toISOString(),
      },
    )
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'user-agent': 'cf-sender',
      // Stable across retries: receivers can deduplicate on it.
      'x-sender-delivery': msg.deliveryId,
    }
    const extra = str(config, 'headers')
    if (extra) Object.assign(headers, JSON.parse(extra) as Record<string, string>)
    const secret = str(config, 'signingSecret')
    if (secret) {
      const ts = String(Math.floor(Date.now() / 1000))
      headers['x-sender-timestamp'] = ts
      headers['x-sender-signature'] = `sha256=${toHex(await hmacSha256(secret, `${ts}.${body}`))}`
    }
    return deliverHttp(str(config, 'url'), { method: str(config, 'method') || 'POST', headers, body })
  },
}
