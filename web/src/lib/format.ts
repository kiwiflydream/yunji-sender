import type { BadgeVariant } from '@cloudflare/kumo'
import { formatInZone } from '../../../src/lib/time'
import type { DeliveryStatus, MessageLevel, MessageSource, MessageStatus } from '../../../src/shared/types'

export const viewerTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone

export const fmtTime = (ms: number | null | undefined, tz = viewerTimezone) => (ms ? formatInZone(ms, tz) : '—')

export function fmtRelative(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '—'
  const diff = ms - now
  const abs = Math.abs(diff)
  const suffix = diff > 0 ? '后' : '前'
  if (abs < 5_000) return diff > 0 ? '即将' : '刚刚'
  if (abs < 60_000) return `${Math.round(abs / 1000)} 秒${suffix}`
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} 分钟${suffix}`
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} 小时${suffix}`
  return fmtTime(ms)
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`
  const s = Math.round(ms / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/** Rates are floored so 99.96% never reads as 100%. */
export const fmtPercent = (rate: number | null) =>
  rate === null ? '—' : rate === 1 ? '100%' : `${(Math.floor(rate * 1000) / 10).toFixed(1)}%`

export const fmtCount = (n: number) => n.toLocaleString('zh-CN')

/** Stats bucket label: `MM-DD HH:00` for hourly buckets, `MM-DD` for daily ones. */
export const fmtBucket = (ms: number, granularity: 'hour' | 'day') =>
  formatInZone(ms, viewerTimezone).slice(5, granularity === 'hour' ? 16 : 10)

export const MESSAGE_STATUS: Record<MessageStatus, { label: string; variant: BadgeVariant }> = {
  scheduled: { label: '定时', variant: 'info' },
  pending: { label: '投递中', variant: 'info' },
  sent: { label: '已送达', variant: 'success' },
  partial: { label: '部分失败', variant: 'warning' },
  failed: { label: '失败', variant: 'error' },
  canceled: { label: '已取消', variant: 'neutral' },
}

export const DELIVERY_STATUS: Record<DeliveryStatus, { label: string; variant: BadgeVariant }> = {
  scheduled: { label: '等待中', variant: 'info' },
  queued: { label: '已入队', variant: 'info' },
  sending: { label: '发送中', variant: 'info' },
  sent: { label: '已送达', variant: 'success' },
  failed: { label: '失败', variant: 'error' },
  canceled: { label: '已取消', variant: 'neutral' },
}

export const LEVEL: Record<MessageLevel, { label: string; variant: BadgeVariant }> = {
  info: { label: '通知', variant: 'neutral' },
  warn: { label: '警告', variant: 'warning' },
  error: { label: '错误', variant: 'error' },
}

export const SOURCE: Record<MessageSource, string> = { api: 'API', rpc: 'RPC', admin: '后台' }
