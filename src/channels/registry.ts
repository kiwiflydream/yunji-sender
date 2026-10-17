import type { ChannelType } from '../shared/types'
import { barkProvider } from './providers/bark'
import { dingtalkProvider } from './providers/dingtalk'
import { discordProvider } from './providers/discord'
import { emailProvider } from './providers/email'
import { feishuProvider } from './providers/feishu'
import { pushplusProvider } from './providers/pushplus'
import { serverchanProvider } from './providers/serverchan'
import { slackProvider } from './providers/slack'
import { telegramProvider } from './providers/telegram'
import { webhookProvider } from './providers/webhook'
import { wecomProvider } from './providers/wecom'
import type { ChannelProvider } from './types'

const PROVIDERS: Record<ChannelType, ChannelProvider> = {
  webhook: webhookProvider,
  telegram: telegramProvider,
  feishu: feishuProvider,
  wecom: wecomProvider,
  dingtalk: dingtalkProvider,
  slack: slackProvider,
  discord: discordProvider,
  bark: barkProvider,
  pushplus: pushplusProvider,
  serverchan: serverchanProvider,
  email: emailProvider,
}

export function getProvider(type: ChannelType): ChannelProvider {
  return PROVIDERS[type]
}
