import { Input, Text } from '@cloudflare/kumo'
import { renderedTemplateLength, renderTemplate, templateVariables } from '../../../src/shared/templates'
import type { TemplateVariables } from '../../../src/shared/types'

export function TemplatePreview({ content, values, onChange, errors = {} }: {
  content: { title: string; body: string }
  values: TemplateVariables
  onChange: (values: TemplateVariables) => void
  errors?: Record<string, string>
}) {
  const keys = templateVariables(content)
  const tooLong = renderedTemplateLength(content.title, values) > 256 || renderedTemplateLength(content.body, values) > 16 * 1024
  const rendered = tooLong ? { title: '内容超过长度限制', body: '标题最多 256 字符，正文最多 16 KB，请缩短变量或模板内容。' } : renderTemplate(content, values)
  return (
    <div className="flex flex-col gap-4">
      {keys.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {keys.map((key) => (
            <Input key={key} label={key} description="必填变量" maxLength={16 * 1024} value={Object.hasOwn(values, key) ? String(values[key]) : ''}
              onChange={(e) => onChange({ ...values, [key]: e.target.value })} error={errors[`variables.${key}`]} />
          ))}
        </div>
      )}
      <div className="rounded-lg border border-kumo-hairline bg-kumo-canvas p-4" aria-label="消息预览">
        <Text size="xs" variant="secondary">消息预览</Text>
        <div className="mt-2 break-words font-medium">{rendered.title || '（无标题）'}</div>
        <div className="mt-2 whitespace-pre-wrap break-words text-sm">{rendered.body || '（无正文）'}</div>
      </div>
    </div>
  )
}
