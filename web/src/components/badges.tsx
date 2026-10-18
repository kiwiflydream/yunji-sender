import { tr, useLocale } from '../i18n'
import { Badge } from '@cloudflare/kumo'
import { CHANNEL_CATALOG } from '../../../src/shared/catalog'
import type { ChannelType, DeliveryStatus, MessageLevel, MessageStatus } from '../../../src/shared/types'
import { DELIVERY_STATUS, LEVEL, MESSAGE_STATUS } from '../lib/format'

export function MessageStatusBadge({ status }: { status: MessageStatus }) {
  useLocale()
  const meta = MESSAGE_STATUS[status]
  return <Badge variant={meta.variant}>{tr(meta.label)}</Badge>
}

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  useLocale()
  const meta = DELIVERY_STATUS[status]
  return <Badge variant={meta.variant}>{tr(meta.label)}</Badge>
}

export function LevelBadge({ level }: { level: MessageLevel }) {
  useLocale()
  if (level === 'info') return null
  const meta = LEVEL[level]
  return <Badge variant={meta.variant}>{tr(meta.label)}</Badge>
}

export function ChannelTypeBadge({ type }: { type: ChannelType }) {
  useLocale()
  return <Badge variant="outline">{tr(CHANNEL_CATALOG[type].label)}</Badge>
}

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  useLocale()
  return (
    <Badge appearance="dot" variant={enabled ? 'success' : 'neutral'}>
      {enabled ? tr('启用') : tr('停用')}
    </Badge>
  )
}
