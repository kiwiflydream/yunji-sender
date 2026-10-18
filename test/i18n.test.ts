import { describe, expect, it } from 'vitest'
import { createI18n, translate } from '../web/src/i18n-core'
import { detectLocale } from '../web/src/locale'
import { localizeIssue } from '../web/src/lib/issue-message'
import { en } from '../web/src/locales/en'

describe('interface localization', () => {
  it('prioritizes a saved choice, recognizes language variants and falls back for unsupported languages', () => {
    expect(detectLocale('en', ['zh-CN'])).toBe('en')
    expect(detectLocale('zh-CN', ['en-US'])).toBe('zh-CN')
    expect(detectLocale(null, ['zh-TW', 'en'])).toBe('zh-CN')
    expect(detectLocale(null, ['en-GB', 'zh-CN'])).toBe('en')
    expect(detectLocale('corrupt', ['fr', 'ZH-HK'])).toBe('zh-CN')
    expect(detectLocale(null, ['fr'])).toBe('en')
    expect(detectLocale(null, [])).toBe('en')
  })

  it('changes existing copy immediately, including English plurals and Chinese counters', async () => {
    const instance = createI18n('en')
    const key = '已取消 {%value0%} 个投递'
    expect(translate(instance, key, { value0: 1, count: 1 })).toBe('Canceled 1 delivery')
    expect(translate(instance, key, { value0: 2, count: 2 })).toBe('Canceled 2 deliveries')
    await instance.changeLanguage('zh-CN')
    expect(translate(instance, key, { value0: 1, count: 1 })).toBe('已取消 1 个投递')
    expect(translate(instance, key, { value0: 2, count: 2 })).toBe('已取消 2 个投递')
    expect(translate(instance, '云吉 Sender')).toBe('云吉 Sender')
  })

  it('keeps template placeholders and interpolated user values literal', () => {
    const instance = createI18n('en')
    const help = translate(instance, '使用 {{variableName}} 插入变量，例如：订单号 {{orderNo}}。模板 ID 创建后不可修改。')
    expect(help).toContain('{{variableName}}')
    expect(help).toContain('{{orderNo}}')
    const name = '<b>订单</b> {{name}} {%value1%} $&'
    expect(translate(instance, '删除 {%value0%}', { value0: name })).toBe(`Delete ${name}`)
    expect(translate(instance, 'unknown-provider-diagnostic')).toBe('unknown-provider-diagnostic')
  })

  it('localizes validation errors while retaining field values and unknown upstream diagnostics', async () => {
    const instance = createI18n('en')
    const tr = (text: string, values?: Record<string, unknown>) => translate(instance, text, values)
    expect(localizeIssue('渠道已停用：值班群', tr)).toBe('Channels disabled: 值班群')
    expect(localizeIssue('发件人不能为空', tr)).toBe('From is required.')
    expect(localizeIssue('缺少变量：orderNo', tr)).toBe('Missing variable: orderNo')
    const issue = 'Too big: expected number to be <=10'
    expect(localizeIssue(issue, tr)).toBe('Must be less than or equal to 10.')
    await instance.changeLanguage('zh-CN')
    expect(localizeIssue(issue, tr)).toBe('必须小于或等于 10')
    expect(localizeIssue('Invalid input: expected string, received undefined', tr)).toBe('应为 字符串，实际为 未提供')
    expect(localizeIssue('upstream: 自定义服务错误 <x>', tr)).toBe('upstream: 自定义服务错误 <x>')
    expect(localizeIssue(undefined, tr)).toBeUndefined()
  })

  it('retains every interpolation parameter across all English translations', () => {
    const parameters = (text: string) => [...new Set([...text.matchAll(/\{%([^%]+)%\}/g)].map((match) => match[1]))].sort()
    for (const [key, value] of Object.entries(en)) {
      expect(parameters(value), key).toEqual(parameters(key))
    }
  })
})
