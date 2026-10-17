import { truncateChars } from '../../lib/http-body'
import { postJson } from '../http'
import { headline, joinSections, tagLine } from '../render'
import { str, type ChannelConfig, type ChannelProvider, type OutboundMessage } from '../types'

const COLOR = { info: 0x3b82f6, warn: 0xf59e0b, error: 0xef4444 } as const

export function discordPayload(config: ChannelConfig, msg: OutboundMessage): Record<string, unknown> {
  const title = headline(msg)
  return {
    ...(str(config, 'username') ? { username: str(config, 'username') } : {}),
    // Never ping @everyone / roles from notification text.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        ...(title ? { title: truncateChars(title, 256) } : {}),
        ...(msg.url ? { url: msg.url } : {}),
        description: truncateChars(joinSections(msg.body, msg.tags.length ? tagLine(msg) : ''), 4096),
        color: COLOR[msg.level],
        timestamp: new Date(msg.createdAt).toISOString(),
      },
    ],
  }
}

export const discordProvider: ChannelProvider = {
  type: 'discord',
  send(config, msg) {
    // wait=true makes Discord validate and return the message instead of a blind 204.
    const url = new URL(str(config, 'webhookUrl'))
    url.searchParams.set('wait', 'true')
    return postJson(url.toString(), msg.raw ?? discordPayload(config, msg))
  },
}
