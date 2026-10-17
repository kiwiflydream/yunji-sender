import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  Input,
  InputArea,
  Select,
  TagInput,
  Tabs,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useLocation } from 'wouter'
import { zonedTimeToEpoch } from '../../../src/lib/time'
import type { MessageFormat, MessageLevel, SendRequest } from '../../../src/shared/types'
import { api, ApiError, errorMessage } from '../api'
import { LEVEL, viewerTimezone } from '../lib/format'

type Target = 'topic' | 'channels'

export function SendDialog({ onClose }: { onClose: () => void }) {
  const topics = useQuery({ queryKey: ['topics'], queryFn: api.topics })
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels })
  const [target, setTarget] = useState<Target>('topic')
  const [topic, setTopic] = useState('')
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
      const input: SendRequest = { title, body, format, level, url: url || null, tags }
      if (target === 'topic') input.topic = topic
      else input.channels = channelIds
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
          <Tabs
            variant="segmented"
            value={target}
            onValueChange={(v) => setTarget(v as Target)}
            tabs={[
              { value: 'topic', label: '按主题' },
              { value: 'channels', label: '指定渠道' },
            ]}
          />
          {target === 'topic' ? (
            <Select
              label="主题"
              placeholder={topics.data?.length === 0 ? '还没有主题' : '选择主题'}
              value={topic || null}
              onValueChange={(v) => setTopic(String(v ?? ''))}
              items={Object.fromEntries((topics.data ?? []).map((t) => [t.slug, `${t.name}（${t.slug}）`]))}
              {...err('topic')}
            >
              {(topics.data ?? []).map((t) => (
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
            <Button type="submit" variant="primary" loading={send.isPending}>
              发送
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
