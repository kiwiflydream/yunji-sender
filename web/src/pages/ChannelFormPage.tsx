import {
  Banner,
  Button,
  Input,
  InputArea,
  LayerCard,
  Select,
  SensitiveInput,
  Switch,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import { PaperPlaneRightIcon, TrashIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useLocation } from 'wouter'
import { CHANNEL_CATALOG, type ChannelField } from '../../../src/shared/catalog'
import { CHANNEL_TYPES, type Channel, type ChannelConfigValue, type ChannelTestResult, type ChannelType } from '../../../src/shared/types'
import { api, ApiError, errorMessage } from '../api'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { PageHeader } from '../components/PageHeader'
import { ErrorBanner, NotFound, PageLoader } from '../components/States'
import { TestResultBanner } from '../components/TestResult'

export function ChannelFormPage({ id }: { id?: string }) {
  const channel = useQuery({ queryKey: ['channel', id], queryFn: () => api.channel(id!), enabled: !!id })
  if (!id) return <ChannelForm />
  if (channel.isPending) return <PageLoader />
  if (channel.isError) return channel.error instanceof ApiError && channel.error.status === 404 ? <NotFound /> : <ErrorBanner error={channel.error} />
  return <ChannelForm initial={channel.data} />
}

function defaults(type: ChannelType): Record<string, ChannelConfigValue> {
  return Object.fromEntries(
    CHANNEL_CATALOG[type].fields.map((f) => [f.key, f.default ?? (f.kind === 'boolean' ? false : '')]),
  )
}

function ChannelForm({ initial }: { initial?: Channel }) {
  const [type, setType] = useState<ChannelType>(initial?.type ?? 'webhook')
  const [name, setName] = useState(initial?.name ?? '')
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [config, setConfig] = useState<Record<string, ChannelConfigValue>>(() => ({ ...defaults(type), ...initial?.config }))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<ChannelTestResult | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [, navigate] = useLocation()
  const toasts = useKumoToastManager()
  const qc = useQueryClient()
  const info = CHANNEL_CATALOG[type]

  const save = useMutation({
    mutationFn: () => {
      const input = { name, type, enabled, config }
      return initial ? api.updateChannel(initial.id, input) : api.createChannel(input)
    },
    onSuccess: (saved) => {
      toasts.add({ title: initial ? '渠道已保存' : '渠道已添加', variant: 'success' })
      qc.invalidateQueries({ queryKey: ['channels'] })
      qc.setQueryData(['channel', saved.id], saved)
      navigate(initial ? '/channels' : `/channels/${saved.id}`)
    },
    onError: (err) => {
      const fields: Record<string, string> = {}
      if (err instanceof ApiError) for (const i of err.issues) fields[i.path] = i.message
      setErrors(fields)
      setError(Object.keys(fields).length ? '保存失败，请检查标出的字段。' : errorMessage(err))
    },
  })
  const test = useMutation({
    mutationFn: () => api.testChannel(initial!.id),
    onSuccess: setTestResult,
    onError: (err) => toasts.add({ title: '测试失败', description: errorMessage(err), variant: 'error' }),
  })
  const remove = useMutation({
    mutationFn: () => api.deleteChannel(initial!.id),
    onSuccess: () => {
      toasts.add({ title: '渠道已删除', variant: 'success' })
      qc.invalidateQueries({ queryKey: ['channels'] })
      qc.invalidateQueries({ queryKey: ['channelGroups'] })
      navigate('/channels')
    },
    onError: (err) => toasts.add({ title: '删除失败', description: errorMessage(err), variant: 'error' }),
  })

  const changeType = (next: ChannelType) => {
    setType(next)
    setConfig(defaults(next))
    setErrors({})
  }

  return (
    <>
      <PageHeader
        crumbs={[{ label: '渠道', href: '/channels' }, { label: initial ? initial.name : '添加' }]}
        title={initial ? initial.name : '添加渠道'}
        actions={
          initial && (
            <>
              <Button icon={PaperPlaneRightIcon} loading={test.isPending} onClick={() => test.mutate()}>
                发送测试消息
              </Button>
              <Button variant="ghost" icon={TrashIcon} onClick={() => setDeleting(true)}>
                删除
              </Button>
            </>
          )
        }
      />
      {testResult && (
        <div className="mb-4">
          <TestResultBanner result={testResult} />
        </div>
      )}
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <LayerCard>
          <LayerCard.Secondary>基本信息</LayerCard.Secondary>
          <LayerCard.Primary className="flex flex-col gap-4">
            <Select
              label="类型"
              value={type}
              disabled={!!initial}
              description={initial ? '类型创建后不能修改。' : info.description}
              onValueChange={(v) => changeType(v as ChannelType)}
              items={Object.fromEntries(CHANNEL_TYPES.map((t) => [t, CHANNEL_CATALOG[t].label]))}
            >
              {CHANNEL_TYPES.map((t) => (
                <Select.Option key={t} value={t}>
                  {CHANNEL_CATALOG[t].label}
                </Select.Option>
              ))}
            </Select>
            <Input label="名称" value={name} onChange={(e) => setName(e.target.value)} {...(errors.name ? { error: errors.name } : {})} />
            <Switch label="启用" checked={enabled} onCheckedChange={setEnabled} />
          </LayerCard.Primary>
        </LayerCard>
        <LayerCard>
          <LayerCard.Secondary>
            <div className="flex flex-col">
              <span>{info.label} 配置</span>
              <Text size="xs" variant="secondary">
                {info.markdown === 'native' ? 'Markdown 原样发送。' : info.markdown === 'converted' ? 'Markdown 自动转换为该渠道支持的格式。' : 'Markdown 以纯文本发送。'}
                带锁图标的字段加密保存，编辑时留空表示不修改。
              </Text>
            </div>
          </LayerCard.Secondary>
          <LayerCard.Primary className="flex flex-col gap-4">
            {info.fields.map((f) => (
              <FieldInput
                key={`${type}.${f.key}`}
                field={f}
                value={config[f.key]}
                isSet={initial?.secretsSet.includes(f.key) ?? false}
                error={errors[`config.${f.key}`]}
                onChange={(v) => setConfig((c) => ({ ...c, [f.key]: v }))}
              />
            ))}
          </LayerCard.Primary>
        </LayerCard>
        {error && <Banner variant="error" description={error} />}
        <div className="flex justify-end gap-2">
          <Button onClick={() => navigate('/channels')}>取消</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            保存
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="删除渠道"
        description={`确定删除 ${initial?.name}？它会从所有渠道组中移除，等待中的投递会失败。`}
        confirmLabel="删除"
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  )
}

function FieldInput(props: {
  field: ChannelField
  value: ChannelConfigValue | undefined
  isSet: boolean
  error?: string
  onChange: (v: ChannelConfigValue) => void
}) {
  const { field: f, error } = props
  const err = error ? { error } : {}
  const label = f.secret ? `🔒 ${f.label}` : f.label
  const placeholder = f.secret && props.isSet ? '已设置，留空保持不变' : f.placeholder
  if (f.kind === 'boolean') {
    return <Switch label={f.label} checked={props.value === true} onCheckedChange={props.onChange} />
  }
  if (f.kind === 'select') {
    return (
      <Select label={label} value={String(props.value ?? '')} onValueChange={(v) => props.onChange(String(v))} description={f.help} {...err}>
        {f.options!.map((o) => (
          <Select.Option key={o} value={o}>
            {o}
          </Select.Option>
        ))}
      </Select>
    )
  }
  const value = typeof props.value === 'string' ? props.value : ''
  if (f.kind === 'textarea') {
    return (
      <InputArea
        label={label}
        className="font-mono"
        rows={3}
        placeholder={placeholder}
        description={f.help}
        value={value}
        onChange={(e) => props.onChange(e.target.value)}
        {...err}
      />
    )
  }
  if (f.secret) {
    return (
      <SensitiveInput
        label={label}
        placeholder={placeholder}
        description={f.help}
        autoComplete="off"
        value={value}
        onValueChange={props.onChange}
        {...err}
      />
    )
  }
  return (
    <Input
      label={label}
      className={f.kind === 'url' ? 'font-mono' : undefined}
      placeholder={placeholder}
      description={f.help}
      value={value}
      onChange={(e) => props.onChange(e.target.value)}
      {...err}
    />
  )
}
