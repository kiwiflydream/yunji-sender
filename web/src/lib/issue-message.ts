import type { Translator } from '../i18n-core'

const types: Record<string, string> = {
  string: '字符串', number: '数字', int: '整数', boolean: '布尔值', array: '数组',
  object: '对象', undefined: '未提供', null: '空值',
}

/** Translate our validation messages, preserving field values and provider diagnostics. */
export function localizeIssue(message: string | undefined, tr: Translator): string | undefined {
  if (!message) return message
  if (message === 'Invalid input') return tr('输入不符合要求')
  const direct = tr(message)
  if (direct !== message) return direct

  const patterns: [RegExp, string][] = [
    [/^缺少变量：(.+)$/s, '缺少变量：{%value0%}'],
    [/^渠道组不存在：(.+)$/s, '渠道组不存在：{%value0%}'],
    [/^渠道不存在：(.+)$/s, '渠道不存在：{%value0%}'],
    [/^渠道已停用：(.+)$/s, '渠道已停用：{%value0%}'],
    [/^无效的邮箱地址：(.+)$/s, '无效的邮箱地址：{%value0%}'],
    [/^只能是 (.+)$/s, '只能是 {%value0%}'],
    [/^此 API Key 不能发送到渠道组 (.+)$/s, '此 API Key 不能发送到渠道组 {%value0%}'],
    [/^Too small: expected string to have >=(\d+) characters$/, '至少需要 {%value0%} 个字符'],
    [/^Too big: expected string to have <=(\d+) characters$/, '最多允许 {%value0%} 个字符'],
    [/^Too small: expected array to have >=(\d+) items$/, '至少需要 {%value0%} 项'],
    [/^Too big: expected array to have <=(\d+) items$/, '最多允许 {%value0%} 项'],
    [/^Too small: expected number to be >=(-?[\d.]+)$/, '必须大于或等于 {%value0%}'],
    [/^Too big: expected number to be <=(-?[\d.]+)$/, '必须小于或等于 {%value0%}'],
    [/^Invalid option: expected (?:one of )?(.+)$/s, '请选择有效值：{%value0%}'],
    [/^Unrecognized keys?: (.+)$/s, '不支持的字段：{%value0%}'],
    [/^Invalid string: must match pattern (.+)$/s, '必须匹配格式：{%value0%}'],
  ]
  for (const [pattern, key] of patterns) {
    const match = pattern.exec(message)
    if (match) return tr(key, { value0: match[1] })
  }
  const required = /^(.*)不能为空$/s.exec(message)
  if (required) return tr('{%value0%}不能为空', { value0: tr(required[1]) })
  const invalidType = /^Invalid input: expected (.+?), received (.+)$/s.exec(message)
  if (invalidType) return tr('应为 {%value0%}，实际为 {%value1%}', {
    value0: tr(types[invalidType[1]] ?? invalidType[1]), value1: tr(types[invalidType[2]] ?? invalidType[2]),
  })
  return message
}
