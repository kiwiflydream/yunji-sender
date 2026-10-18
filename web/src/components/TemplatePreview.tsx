import { issueMessage } from '../api'
import { tr, useLocale } from '../i18n'
import { Input, Text } from '@cloudflare/kumo'
import { renderedTemplateLength, renderTemplate, templateVariables } from '../../../src/shared/templates'
import type { TemplateVariables } from '../../../src/shared/types'

export function TemplatePreview({ content, values, onChange, errors = {} }: {
  content: { title: string; body: string }
  values: TemplateVariables
  onChange: (values: TemplateVariables) => void
  errors?: Record<string, string>
}) {
  useLocale()
  const keys = templateVariables(content)
  const tooLong = renderedTemplateLength(content.title, values) > 256 || renderedTemplateLength(content.body, values) > 16 * 1024
  const rendered = tooLong ? { title: tr('内容超过长度限制'), body: tr('标题最多 256 字符，正文最多 16 KB，请缩短变量或模板内容。') } : renderTemplate(content, values)
  return (
    <div className="flex flex-col gap-4">
      {keys.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {keys.map((key) => (
            <Input key={key} label={key} description={tr('必填变量')} maxLength={16 * 1024} value={Object.hasOwn(values, key) ? String(values[key]) : ''}
              onChange={(e) => onChange({ ...values, [key]: e.target.value })} error={issueMessage(errors[`variables.${key}`])} />
          ))}
        </div>
      )}
      <div className="rounded-lg border border-kumo-hairline bg-kumo-canvas p-4" aria-label={tr('消息预览')}>
        <Text size="xs" variant="secondary">{tr('消息预览')}</Text>
        <div className="mt-2 break-words font-medium">{rendered.title || tr('（无标题）')}</div>
        <div className="mt-2 whitespace-pre-wrap break-words text-sm">{rendered.body || tr('（无正文）')}</div>
      </div>
    </div>
  )
}
