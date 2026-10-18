import { tr, useLocale } from '../i18n'
import { Banner } from '@cloudflare/kumo'
import { CheckCircleIcon, WarningCircleIcon } from '@phosphor-icons/react'
import type { ChannelTestResult } from '../../../src/shared/types'
import { fmtDuration } from '../lib/format'

export function TestResultBanner({ result }: { result: ChannelTestResult }) {
  useLocale()
  return result.ok ? (
    <Banner
      variant="secondary"
      icon={<CheckCircleIcon weight="fill" className="text-kumo-success" />}
      title={tr('测试消息已发送')}
      description={tr('HTTP {%value0%} · {%value1%}，请到目标渠道确认收到。', { value0: result.httpStatus ?? '—', value1: fmtDuration(result.durationMs) })}
    />
  ) : (
    <Banner
      variant="error"
      icon={<WarningCircleIcon weight="fill" />}
      title={tr('发送失败')}
      description={[result.error, result.responseBody].filter(Boolean).join('\n')}
    />
  )
}
