import { getProvider } from '../channels/registry'
import { redact } from '../lib/redact'
import type { ChannelTestResult } from '../shared/types'
import { loadChannel } from './channels'

/** Send a sample message synchronously, bypassing queue, retries and logs. */
export async function testChannel(env: CloudflareBindings, id: string, now = Date.now()): Promise<ChannelTestResult | null> {
  const channel = await loadChannel(env, id)
  if (!channel) return null
  const testId = `test-${crypto.randomUUID()}`
  let outcome
  try {
    outcome = await getProvider(channel.type).send(channel.config, {
      deliveryId: testId,
      messageId: testId,
      channelGroup: null,
      createdAt: now,
      title: '云吉 Sender 测试消息',
      body: `渠道 **${channel.name}** 配置正确。\n\n发送时间：\`${new Date(now).toISOString()}\``,
      format: 'markdown',
      level: 'info',
      url: null,
      tags: ['test'],
      raw: null,
    })
  } catch (err) {
    return { ok: false, httpStatus: null, error: redact(String(err instanceof Error ? err.message : err), channel.secretValues), responseBody: null, durationMs: 0 }
  }
  return {
    ok: outcome.ok,
    httpStatus: outcome.httpStatus,
    error: outcome.ok ? null : redact(outcome.error, channel.secretValues),
    responseBody: outcome.responseBody === null ? null : redact(outcome.responseBody, channel.secretValues),
    durationMs: outcome.durationMs,
  }
}
