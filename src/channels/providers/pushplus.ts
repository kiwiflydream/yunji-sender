import { postJson } from '../http'
import { footerLines, headline, joinSections } from '../render'
import { str, type ChannelProvider } from '../types'

export const pushplusProvider: ChannelProvider = {
  type: 'pushplus',
  send(config, msg) {
    const content = joinSections(msg.body, footerLines(msg).join('\n')) || msg.title || ' '
    const payload = {
      ...(msg.raw ?? { title: headline(msg), content, template: msg.format === 'markdown' ? 'markdown' : 'txt' }),
      // Routing and credentials always come from the saved channel, including
      // omitted optional fields, so raw cannot redirect a restricted caller.
      token: str(config, 'token'),
      channel: str(config, 'channel') || 'wechat',
      topic: str(config, 'topic') || undefined,
      option: str(config, 'option') || undefined,
      to: str(config, 'to') || undefined,
    }
    return postJson('https://www.pushplus.plus/send', payload, {}, (json) => {
      if (json?.code === 200) return null
      if (typeof json?.code !== 'number') return { error: 'PushPlus 返回无效响应' }
      // 900 is an account restriction: the official API explicitly says to stop.
      return { error: `PushPlus 返回 ${json.code}: ${json.msg ?? ''}`.trim(), retryable: json.code === 500 }
    })
  },
}
