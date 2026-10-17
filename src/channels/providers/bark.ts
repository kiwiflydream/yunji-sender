import { postJson } from '../http'
import { joinSections, plainBody, tagLine } from '../render'
import { str, type ChannelConfig, type ChannelProvider, type OutboundMessage } from '../types'

const LEVEL = { info: 'active', warn: 'timeSensitive', error: 'timeSensitive' } as const

export function barkPayload(config: ChannelConfig, msg: OutboundMessage): Record<string, unknown> {
  const optional = (key: string) => (str(config, key) ? { [key]: str(config, key) } : {})
  return {
    ...(msg.title ? { title: msg.title } : {}),
    body: joinSections(plainBody(msg), msg.tags.length ? tagLine(msg) : '') || ' ',
    level: LEVEL[msg.level],
    ...(msg.url ? { url: msg.url } : {}),
    ...optional('group'),
    ...optional('sound'),
    ...optional('icon'),
  }
}

export const barkProvider: ChannelProvider = {
  type: 'bark',
  send(config, msg) {
    const server = (str(config, 'serverUrl') || 'https://api.day.app').replace(/\/+$/, '')
    const routing = { device_key: str(config, 'deviceKey') }
    const payload = { ...(msg.raw ?? barkPayload(config, msg)), ...routing }
    return postJson(`${server}/push`, payload, {}, (json) =>
      json?.code === 200 || json?.code === undefined ? null : { error: `Bark 返回 ${json.code}: ${json.message ?? ''}`.trim() },
    )
  },
}
