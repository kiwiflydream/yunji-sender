// Channel type metadata shared by the Worker (config validation) and the admin
// SPA (generated forms). Adding a channel type: add it to CHANNEL_TYPES, describe
// its fields here and register a provider in src/channels/registry.ts.
import type { ChannelType } from './types'

export interface ChannelField {
  key: string
  label: string
  kind: 'text' | 'url' | 'textarea' | 'select' | 'boolean'
  /** Encrypted at rest, never returned; leaving it empty on edit keeps the old value. */
  secret?: boolean
  required?: boolean
  placeholder?: string
  help?: string
  options?: readonly string[]
  default?: string | boolean
}

export interface ChannelTypeInfo {
  label: string
  description: string
  /** How `format: markdown` is rendered. */
  markdown: 'native' | 'converted' | 'plain'
  fields: ChannelField[]
}

export const CHANNEL_CATALOG: Record<ChannelType, ChannelTypeInfo> = {
  webhook: {
    label: 'Webhook',
    description: '向任意 URL 发送 JSON，可选 HMAC-SHA256 签名。',
    markdown: 'native',
    fields: [
      { key: 'url', label: 'URL', kind: 'url', secret: true, required: true, placeholder: 'https://example.com/hooks/notify' },
      { key: 'method', label: '方法', kind: 'select', options: ['POST', 'PUT'], default: 'POST' },
      {
        key: 'headers',
        label: '请求头（JSON 对象）',
        kind: 'textarea',
        secret: true,
        placeholder: '{"Authorization": "Bearer ..."}',
      },
      {
        key: 'signingSecret',
        label: '签名密钥',
        kind: 'text',
        secret: true,
        help: '设置后请求带 X-Sender-Timestamp 和 X-Sender-Signature: sha256=HMAC(密钥, "时间戳.请求体")',
      },
    ],
  },
  telegram: {
    label: 'Telegram',
    description: '通过 Bot API 发送到私聊、群组或频道。',
    markdown: 'converted',
    fields: [
      { key: 'botToken', label: 'Bot Token', kind: 'text', secret: true, required: true, placeholder: '123456:ABC-DEF...' },
      { key: 'chatId', label: 'Chat ID', kind: 'text', required: true, placeholder: '-1001234567890 或 @channel' },
      { key: 'messageThreadId', label: '话题 ID（可选）', kind: 'text', help: '发到超级群组的指定话题' },
      {
        key: 'apiBase',
        label: 'API 地址',
        kind: 'url',
        default: 'https://api.telegram.org',
        help: '可替换为自建反代',
      },
      { key: 'silent', label: '静默发送', kind: 'boolean', default: false },
    ],
  },
  feishu: {
    label: '飞书 / Lark',
    description: '群自定义机器人。Markdown 消息以卡片发送。',
    markdown: 'native',
    fields: [
      {
        key: 'webhookUrl',
        label: 'Webhook 地址',
        kind: 'url',
        secret: true,
        required: true,
        placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...',
      },
      { key: 'signSecret', label: '签名校验密钥（可选）', kind: 'text', secret: true },
    ],
  },
  wecom: {
    label: '企业微信',
    description: '群机器人。',
    markdown: 'native',
    fields: [
      {
        key: 'webhookUrl',
        label: 'Webhook 地址',
        kind: 'url',
        secret: true,
        required: true,
        placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...',
      },
    ],
  },
  dingtalk: {
    label: '钉钉',
    description: '群自定义机器人。用关键词校验时，消息需包含关键词。',
    markdown: 'native',
    fields: [
      {
        key: 'webhookUrl',
        label: 'Webhook 地址',
        kind: 'url',
        secret: true,
        required: true,
        placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...',
      },
      { key: 'signSecret', label: '加签密钥（可选）', kind: 'text', secret: true, placeholder: 'SEC...' },
    ],
  },
  slack: {
    label: 'Slack',
    description: 'Incoming Webhook。Markdown 转为 mrkdwn。',
    markdown: 'converted',
    fields: [
      {
        key: 'webhookUrl',
        label: 'Webhook URL',
        kind: 'url',
        secret: true,
        required: true,
        placeholder: 'https://hooks.slack.com/services/...',
      },
    ],
  },
  discord: {
    label: 'Discord',
    description: '频道 Webhook，以 Embed 发送。',
    markdown: 'native',
    fields: [
      {
        key: 'webhookUrl',
        label: 'Webhook URL',
        kind: 'url',
        secret: true,
        required: true,
        placeholder: 'https://discord.com/api/webhooks/...',
      },
      { key: 'username', label: '显示名称（可选）', kind: 'text' },
    ],
  },
  bark: {
    label: 'Bark',
    description: 'iOS 推送。Markdown 以纯文本发送。',
    markdown: 'plain',
    fields: [
      { key: 'serverUrl', label: '服务器', kind: 'url', default: 'https://api.day.app' },
      { key: 'deviceKey', label: 'Device Key', kind: 'text', secret: true, required: true },
      { key: 'group', label: '分组（可选）', kind: 'text' },
      { key: 'sound', label: '铃声（可选）', kind: 'text', placeholder: 'minuet' },
      { key: 'icon', label: '图标 URL（可选）', kind: 'url' },
    ],
  },
  pushplus: {
    label: 'PushPlus',
    description: '通过 PushPlus 推送到微信或其他已配置的接收渠道。成功表示平台已受理。',
    markdown: 'native',
    fields: [
      { key: 'token', label: 'Token', kind: 'text', secret: true, required: true, help: '用户 Token 或消息 Token' },
      {
        key: 'channel', label: '接收渠道', kind: 'select', default: 'wechat',
        options: ['wechat', 'app', 'extension', 'webhook', 'cp', 'mail', 'qq', 'clawbot', 'cmcc', 'sms', 'voice'],
        help: '默认 wechat（微信公众号）；sms 和 voice 在 PushPlus 按量计费。',
      },
      { key: 'topic', label: '群组编码（可选）', kind: 'text', help: 'PushPlus 的群组编码，留空发送给自己；与本系统的渠道组独立。' },
      { key: 'option', label: '渠道配置编码（可选）', kind: 'text', help: '在 PushPlus 配置的渠道编码，供 webhook、cp、mail、qq 等渠道使用。' },
      { key: 'to', label: '指定接收人（可选）', kind: 'text', secret: true, help: '好友令牌或企业微信用户 ID，多人用逗号分隔。' },
    ],
  },
  serverchan: {
    label: 'Server酱',
    description: '自动识别 Turbo（SCT）和 Server酱³（sctp）SendKey。',
    markdown: 'native',
    fields: [
      { key: 'sendKey', label: 'SendKey', kind: 'text', secret: true, required: true, placeholder: 'SCT... 或 sctp123t...' },
    ],
  },
  email: {
    label: 'Email（Resend）',
    description: '通过 Resend API 发送邮件。Markdown 转为 HTML。',
    markdown: 'converted',
    fields: [
      { key: 'apiKey', label: 'Resend API Key', kind: 'text', secret: true, required: true, placeholder: 're_...' },
      { key: 'from', label: '发件人', kind: 'text', required: true, placeholder: 'Alerts <alerts@example.com>' },
      { key: 'to', label: '收件人', kind: 'text', required: true, placeholder: 'a@example.com, b@example.com' },
      { key: 'cc', label: '抄送（可选）', kind: 'text' },
      { key: 'replyTo', label: '回复地址（可选）', kind: 'text' },
    ],
  },
}
