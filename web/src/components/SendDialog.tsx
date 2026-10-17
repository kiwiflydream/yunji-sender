import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  Input,
  InputArea,
  Select,
  Switch,
  TagInput,
  Tabs,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useLocation } from 'wouter'
import { zonedTimeToEpoch } from '../../../src/lib/time'
import type { MessageFormat, MessageLevel, SendRequest, TemplateVariables } from '../../../src/shared/types'
import { api, ApiError, errorMessage } from '../api'
import { LEVEL, viewerTimezone } from '../lib/format'
import { TemplatePreview } from './TemplatePreview'

type Target = 'channelGroup' | 'channels'

export function SendDialog({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'custom' | 'template'>('custom')
  const templates = useQuery({ queryKey: ['templates'], queryFn: api.templates, enabled: mode === 'template' })
  const [templateId, setTemplateId] = useState('')
  const [variables, setVariables] = useState<TemplateVariables>({})
  const [useDefaults, setUseDefaults] = useState(true)
  const channelGroups = useQuery({ queryKey: ['channelGroups'], queryFn: api.channelGroups })
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels })
  const [target, setTarget] = useState<Target>('channelGroup')
  const [channelGroup, setChannelGroup] = useState('')
  const [channelIds, setChannelIds] = useState<string[]>([])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [format, setFormat] = useState<MessageFormat>('text')
  const [level, setLevel] = useState<MessageLevel>('info')
  const [url, setUrl] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [sendAt, setSendAt] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const toasts = useKumoToastManager()
  const qc = useQueryClient()
  const [, navigate] = useLocation()

  const send = useMutation({
    mutationFn: () => {
      const input: SendRequest = mode === 'template' ? { templateId, variables } : { title, body, format, level, url: url || null, tags }
      if (mode === 'custom' || !useDefaults || !hasDefaults) {
        if (target === 'channelGroup') input.channelGroup = channelGroup
        else input.channels = channelIds
      }
      if (sendAt) input.sendAt = zonedTimeToEpoch(sendAt, viewerTimezone) ?? sendAt
      return api.send(input)
    },
    onSuccess: (result) => {
      toasts.add({ title: `已提交，投递到 ${result.deliveries.length} 个渠道`, variant: 'success' })
      qc.invalidateQueries({ queryKey: ['messages'] })
      onClose()
      navigate(`/messages/${result.messageId}`)
    },
    onError: (err) => {
      const fields: Record<string, string> = {}
      if (err instanceof ApiError) for (const i of err.issues) fields[i.path || 'other'] = i.message
      setErrors(fields)
      setError(Object.keys(fields).length ? null : errorMessage(err))
    },
  })

  const enabledChannels = channels.data?.filter((c) => c.enabled) ?? []
  const selectedTemplate = templates.data?.find((t) => t.id === templateId)
  const hasDefaults = !!(selectedTemplate?.channelGroup || selectedTemplate?.channels.length)
  const err = (path: string) => (errors[path] ? { error: errors[path] } : {})

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog size="lg" className="max-h-[90svh] overflow-y-auto p-6">
        <Dialog.Title className="text-lg font-semibold">发送消息</Dialog.Title>
        <form
          className="mt-4 flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            send.mutate()
          }}
        >
          <Tabs variant="segmented" value={mode} onValueChange={(v) => { setMode(v as 'custom' | 'template'); setErrors({}); setError(null) }}
            tabs={[{ value: 'custom', label: '自定义消息' }, { value: 'template', label: '使用模板' }]} />
          {mode === 'template' && (
            <>
              {templates.isError && <Banner variant="error" description={errorMessage(templates.error)} />}
              <Select label="消息模板" placeholder={templates.isPending ? '正在加载模板…' : templates.data?.length ? '选择模板' : '还没有模板'}
                value={templateId || null} items={Object.fromEntries((templates.data ?? []).map((t) => [t.id, t.name]))}
                onValueChange={(v) => { setTemplateId(String(v ?? '')); setVariables({}); setUseDefaults(true); setTarget('channels'); setErrors({}); setError(null) }} error={errors.templateId}>
                {(templates.data ?? []).map((t) => <Select.Option key={t.id} value={t.id}>{t.name}</Select.Option>)}
              </Select>
              {selectedTemplate && <TemplatePreview content={selectedTemplate} values={variables} onChange={(next) => {
                setVariables(next)
                setErrors((previous) => {
                  const remaining = { ...previous }
                  for (const key of Object.keys(next)) if (next[key] !== variables[key]) delete remaining[`variables.${key}`]
                  delete remaining.title
                  delete remaining.body
                  return remaining
                })
              }} errors={errors} />}
              {hasDefaults && (
                <Switch label="使用模板默认发送目标" checked={useDefaults} onCheckedChange={setUseDefaults} />
              )}
              {hasDefaults && useDefaults && <Text size="sm" variant="secondary">发送到模板预设的{selectedTemplate?.channelGroup ? `渠道组 ${selectedTemplate.channelGroup}` : ''}{selectedTemplate?.channelGroup && selectedTemplate.channels.length ? ' 和 ' : ''}{selectedTemplate?.channels.length ? `${selectedTemplate.channels.length} 个渠道` : ''}。</Text>}
            </>
          )}
          {(mode === 'custom' || (selectedTemplate && (!useDefaults || !hasDefaults))) && <>
          <Tabs
            variant="segmented"
            value={target}
            onValueChange={(v) => setTarget(v as Target)}
            tabs={[
              { value: 'channelGroup', label: '按渠道组' },
              { value: 'channels', label: '指定渠道' },
            ]}
          />
          {target === 'channelGroup' ? (
            <Select
              label="渠道组"
              placeholder={channelGroups.data?.length === 0 ? '还没有渠道组' : '选择渠道组'}
              value={channelGroup || null}
              onValueChange={(v) => setChannelGroup(String(v ?? ''))}
              items={Object.fromEntries((channelGroups.data ?? []).map((t) => [t.slug, `${t.name}（${t.slug}）`]))}
              {...err('channelGroup')}
            >
              {(channelGroups.data ?? []).map((t) => (
                <Select.Option key={t.id} value={t.slug}>
                  {t.name}（{t.slug}）
                </Select.Option>
              ))}
            </Select>
          ) : enabledChannels.length === 0 ? (
            <Text variant="secondary">没有启用的渠道。</Text>
          ) : (
            <Checkbox.Group legend="渠道" value={channelIds} onValueChange={setChannelIds} error={errors.channels}>
              {enabledChannels.map((c) => (
                <Checkbox.Item key={c.id} value={c.id} label={c.name} />
              ))}
            </Checkbox.Group>
          )}
          </>}
          {mode === 'template' && errors.channels && <Banner variant="error" description={errors.channels} />}
          {mode === 'template' && errors.channelGroup && <Banner variant="error" description={errors.channelGroup} />}
          {mode === 'template' && (errors.title || errors.body) && <Banner variant="error" description={errors.title || errors.body} />}
          {mode === 'custom' && <>
          <Input label="标题" value={title} onChange={(e) => setTitle(e.target.value)} {...err('title')} />
          <InputArea label="正文" rows={4} value={body} onChange={(e) => setBody(e.target.value)} {...err('body')} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Text size="sm" bold>
                格式
              </Text>
              <Tabs
                variant="segmented"
                value={format}
                onValueChange={(v) => setFormat(v as MessageFormat)}
                tabs={[
                  { value: 'text', label: '纯文本' },
                  { value: 'markdown', label: 'Markdown' },
                ]}
              />
            </div>
            <Select
              label="级别"
              value={level}
              onValueChange={(v) => setLevel(v as MessageLevel)}
              items={{ info: LEVEL.info.label, warn: LEVEL.warn.label, error: LEVEL.error.label }}
            >
              <Select.Option value="info">{LEVEL.info.label}</Select.Option>
              <Select.Option value="warn">{LEVEL.warn.label}</Select.Option>
              <Select.Option value="error">{LEVEL.error.label}</Select.Option>
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="链接（可选）" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} {...err('url')} />
            <TagInput label="标签（可选）" value={tags} onValueChange={setTags} maxValues={10} />
          </div>
          </>}
          <Input
            label="定时发送（可选）"
            type="datetime-local"
            description={`按 ${viewerTimezone} 时间；留空立即发送`}
            value={sendAt}
            onChange={(e) => setSendAt(e.target.value)}
            {...err('sendAt')}
          />
          {(error || errors.other) && <Banner variant="error" size="sm" description={error ?? errors.other} />}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={(p) => <Button {...p}>取消</Button>} />
            <Button type="submit" variant="primary" loading={send.isPending} disabled={mode === 'template' && !selectedTemplate}>
              发送
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
