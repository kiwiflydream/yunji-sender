import { truncateChars } from '../../lib/http-body'
import { postJson } from '../http'
import { footerLines, headline, joinSections, subject } from '../render'
import { str, type ChannelProvider } from '../types'

export const serverchanProvider: ChannelProvider = {
  type: 'serverchan',
  send(config, msg) {
    const key = str(config, 'sendKey')
    const uid = /^sctp(\d+)t/.exec(key)?.[1]
    const endpoint = uid
      ? `https://${uid}.push.ft07.com/send/${encodeURIComponent(key)}.send`
      : `https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`
    const title = truncateChars((headline(msg) || subject(msg)).replace(/[\r\n]+/g, ' '), 32)
    const payload = {
      ...(msg.raw ?? {
        title,
        desp: joinSections(msg.body, footerLines(msg).join('\n')),
        ...(uid && msg.tags.length ? { tags: msg.tags.join('|') } : {}),
      }),
      // Use the recipients configured on the SendKey's platform account.
      channel: undefined,
      openid: undefined,
    }
    return postJson(endpoint, payload, {}, (json) => {
      if (json?.code === 0) return null
      if (typeof json?.code !== 'number') return { error: 'Server酱返回无效响应' }
      return { error: `Server酱返回 ${json.code}: ${json.message ?? json.info ?? ''}`.trim() }
    })
  },
}
