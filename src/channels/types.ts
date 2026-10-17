import type { ChannelConfigValue, ChannelType, MessageContent } from '../shared/types'

/** What an adapter gets for one delivery. `raw` is already narrowed to the channel's own type. */
export interface OutboundMessage extends Omit<MessageContent, 'raw'> {
  deliveryId: string
  messageId: string
  channelGroup: string | null
  createdAt: number
  raw: Record<string, unknown> | null
}

/** Public and decrypted secret fields together. */
export type ChannelConfig = Record<string, ChannelConfigValue>

export type SendOutcome =
  | { ok: true; httpStatus: number | null; responseBody: string | null; durationMs: number }
  | {
      ok: false
      /** Whether a later attempt may succeed (network, timeout, 5xx, rate limit). */
      retryable: boolean
      /** Provider-requested wait (Retry-After), capped by the caller. */
      retryAfterMs: number | null
      httpStatus: number | null
      responseBody: string | null
      error: string
      durationMs: number
    }

export interface ChannelProvider {
  type: ChannelType
  send(config: ChannelConfig, msg: OutboundMessage): Promise<SendOutcome>
}

export const str = (config: ChannelConfig, key: string): string => {
  const v = config[key]
  return typeof v === 'string' ? v : ''
}
