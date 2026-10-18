import { tr, useLocale } from '../i18n'
import { Banner, Button, Checkbox, CodeBlock, Input, InputArea, LayerCard, Select, Text, useKumoToastManager } from '@cloudflare/kumo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useLocation } from 'wouter'
import { templateVariables } from '../../../src/shared/templates'
import type { MessageTemplate, MessageTemplateInput, TemplateVariables } from '../../../src/shared/types'
import { api, ApiError, errorMessage, issueMessage } from '../api'
import { PageHeader } from '../components/PageHeader'
import { ErrorBanner, NotFound, PageLoader } from '../components/States'
import { TemplatePreview } from '../components/TemplatePreview'
import { LEVEL } from '../lib/format'

const NONE = '__none__'

export function TemplateFormPage({ id }: { id?: string }) {
  useLocale()
  const template = useQuery({ queryKey: ['templates', id], queryFn: () => api.template(id!), enabled: !!id })
  if (id && template.isPending) return <PageLoader />
  if (template.isError) return template.error instanceof ApiError && template.error.status === 404 ? <NotFound /> : <ErrorBanner error={template.error} />
  return <TemplateForm key={id ?? 'new'} initial={template.data} />
}

function TemplateForm({ initial }: { initial?: MessageTemplate }) {
  useLocale()
  const [input, setInput] = useState<MessageTemplateInput>(initial ?? {
    id: '', name: '', description: '', title: '', body: '', format: 'text', level: 'info', channelGroup: null, channels: [],
  })
  const [values, setValues] = useState<TemplateVariables>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<Error | string | null>(null)
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels })
  const channelGroups = useQuery({ queryKey: ['channelGroups'], queryFn: api.channelGroups })
  const qc = useQueryClient()
  const toasts = useKumoToastManager()
  const [, navigate] = useLocation()
  const save = useMutation({
    mutationFn: () => initial ? api.updateTemplate(input) : api.createTemplate(input),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['templates'] })
      setErrors({})
      setError(null)
      toasts.add({ title: tr('模板已保存'), variant: 'success' })
      navigate(`/templates/${saved.id}`)
    },
    onError: (err) => {
      const issues = err instanceof ApiError ? err.issues : []
      setErrors(Object.fromEntries(issues.map((issue) => [issue.path, issue.message])))
      setError(issues.length ? '保存失败，请检查标出的字段。' : err)
    },
  })
  const update = <K extends keyof MessageTemplateInput>(key: K, value: MessageTemplateInput[K]) => setInput((prev) => ({ ...prev, [key]: value }))
  const keys = templateVariables(input)
  const channelGroupItems: Record<string, string> = { [NONE]: tr('不使用渠道组'), ...Object.fromEntries((channelGroups.data ?? []).map((t) => [t.slug, `${t.name}（${t.slug}）`])) }
  if (input.channelGroup && !channelGroupItems[input.channelGroup]) channelGroupItems[input.channelGroup] = tr('{%value0%}（渠道组已删除）', { value0: input.channelGroup })
  return (
    <>
      <PageHeader title={initial ? initial.name : tr('创建消息模板')} crumbs={[{ label: tr('模板'), href: '/templates' }, { label: initial ? initial.id : tr('创建') }]}
        description={tr('使用 {{variableName}} 插入变量，例如：订单号 {{orderNo}}。模板 ID 创建后不可修改。')} />
      <form className="grid items-start gap-4 lg:grid-cols-2" noValidate onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
        <LayerCard className="flex flex-col gap-4 p-5">
          <Input label={tr('名称')} value={input.name} onChange={(e) => update('name', e.target.value)} error={issueMessage(errors.name)} />
          <Input label={tr('模板 ID')} placeholder="new-order" disabled={!!initial} value={input.id} onChange={(e) => update('id', e.target.value)} error={issueMessage(errors.id)} />
          <Input label={tr('说明（可选）')} value={input.description} onChange={(e) => update('description', e.target.value)} error={issueMessage(errors.description)} />
          <Input label={tr('标题模板')} value={input.title} onChange={(e) => update('title', e.target.value)} error={issueMessage(errors.title)} />
          <InputArea label={tr('正文模板')} rows={5} value={input.body} onChange={(e) => update('body', e.target.value)} error={issueMessage(errors.body)} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label={tr('格式')} value={input.format} onValueChange={(v) => update('format', v as MessageTemplateInput['format'])} items={{ text: tr('纯文本'), markdown: 'Markdown' }}>
              <Select.Option value="text">{tr('纯文本')}</Select.Option><Select.Option value="markdown">Markdown</Select.Option>
            </Select>
            <Select label={tr('级别')} value={input.level} onValueChange={(v) => update('level', v as MessageTemplateInput['level'])} items={{ info: tr(LEVEL.info.label), warn: tr(LEVEL.warn.label), error: tr(LEVEL.error.label) }}>
              <Select.Option value="info">{tr(LEVEL.info.label)}</Select.Option><Select.Option value="warn">{tr(LEVEL.warn.label)}</Select.Option><Select.Option value="error">{tr(LEVEL.error.label)}</Select.Option>
            </Select>
          </div>
          <Text bold size="sm">{tr('默认发送目标')}</Text>
          <Text size="sm" variant="secondary">{tr('可选择渠道组、渠道或两者；留空时需要在发送请求中指定。')}</Text>
          {channelGroups.isError ? <ErrorBanner error={channelGroups.error} /> : (
            <Select label={tr('默认渠道组（可选）')} value={input.channelGroup ?? NONE} onValueChange={(v) => update('channelGroup', v === NONE ? null : String(v))} items={channelGroupItems} error={issueMessage(errors.channelGroup)}>
              {Object.entries(channelGroupItems).map(([value, label]) => <Select.Option key={value} value={value}>{label}</Select.Option>)}
            </Select>
          )}
          {channels.isError ? <ErrorBanner error={channels.error} /> : channels.isPending ? <Text size="sm" variant="secondary">{tr('正在加载渠道…')}</Text> : channels.data.length ? (
            <Checkbox.Group legend={tr('默认渠道（可多选）')} value={input.channels} onValueChange={(v) => update('channels', v)} error={issueMessage(errors.channels)}>
              {channels.data.map((c) => <Checkbox.Item key={c.id} value={c.id} label={`${c.name}${c.enabled ? '' : tr('（已停用）')}`} />)}
            </Checkbox.Group>
          ) : <Text size="sm" variant="secondary">{tr('还没有渠道，可先保存模板。')}</Text>}
          {input.channels.some((id) => channels.isSuccess && !channels.data.some((c) => c.id === id)) && (
            <Banner variant="alert" description={tr('默认渠道包含已删除的渠道，请清除后重新选择。')} />
          )}
          {input.channels.some((id) => channels.isSuccess && !channels.data.some((c) => c.id === id)) && (
            <Button onClick={() => update('channels', input.channels.filter((id) => channels.data?.some((c) => c.id === id)))}>{tr('清除已删除的渠道')}</Button>
          )}
          {error && <Banner variant="error" description={errorMessage(error)} />}
          <div className="flex justify-end gap-2"><Button onClick={() => navigate('/templates')}>{tr('取消')}</Button><Button type="submit" variant="primary" loading={save.isPending}>{tr('保存模板')}</Button></div>
        </LayerCard>
        <LayerCard className="flex flex-col gap-4 p-5">
          <Text bold>{tr('填写示例变量并预览')}</Text>
          <Text size="sm" variant="secondary">{tr('这里只预览，不发送消息。预览按文本展示，实际格式由所选渠道呈现。')}</Text>
          <TemplatePreview content={input} values={values} onChange={setValues} />
          <Text bold size="sm">{tr('API 请求示例')}</Text>
          <Text size="sm" variant="secondary">{tr('POST /api/send，使用 API Key 认证。配置好默认目标后，只需传入以下内容。')}</Text>
          <CodeBlock lang="jsonc" code={JSON.stringify({ templateId: input.id, variables: Object.fromEntries(keys.map((key) => [key, Object.hasOwn(values, key) ? values[key] : ''])) }, null, 2)} />
        </LayerCard>
      </form>
    </>
  )
}
