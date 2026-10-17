import { Badge } from '@cloudflare/kumo'
import { CHANNEL_CATALOG } from '../../../src/shared/catalog'
import type { ChannelType, DeliveryStatus, MessageLevel, MessageStatus } from '../../../src/shared/types'
import { DELIVERY_STATUS, LEVEL, MESSAGE_STATUS } from '../lib/format'

export function MessageStatusBadge({ status }: { status: MessageStatus }) {
  const meta = MESSAGE_STATUS[status]
  return <Badge variant={meta.variant}>{meta.label}</Badge>
}

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const meta = DELIVERY_STATUS[status]
  return <Badge variant={meta.variant}>{meta.label}</Badge>
}

export function LevelBadge({ level }: { level: MessageLevel }) {
  if (level === 'info') return null
  const meta = LEVEL[level]
  return <Badge variant={meta.variant}>{meta.label}</Badge>
}

export function ChannelTypeBadge({ type }: { type: ChannelType }) {
  return <Badge variant="outline">{CHANNEL_CATALOG[type].label}</Badge>
}

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <Badge appearance="dot" variant={enabled ? 'success' : 'neutral'}>
      {enabled ? '启用' : '停用'}
    </Badge>
  )
}
