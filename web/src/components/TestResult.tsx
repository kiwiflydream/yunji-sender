import { Banner } from '@cloudflare/kumo'
import { CheckCircleIcon, WarningCircleIcon } from '@phosphor-icons/react'
import type { ChannelTestResult } from '../../../src/shared/types'
import { fmtDuration } from '../lib/format'

export function TestResultBanner({ result }: { result: ChannelTestResult }) {
  return result.ok ? (
    <Banner
      variant="secondary"
      icon={<CheckCircleIcon weight="fill" className="text-kumo-success" />}
      title="测试消息已发送"
      description={`HTTP ${result.httpStatus ?? '—'} · ${fmtDuration(result.durationMs)}，请到目标渠道确认收到。`}
    />
  ) : (
    <Banner
      variant="error"
      icon={<WarningCircleIcon weight="fill" />}
      title="发送失败"
      description={[result.error, result.responseBody].filter(Boolean).join('\n')}
    />
  )
}
