import { Button, CodeBlock, Input, LayerCard, Radio, Text, useKumoToastManager } from '@cloudflare/kumo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { AdminMe, RuntimeSettings } from '../../../src/shared/types'
import { api, ApiError, errorMessage } from '../api'
import { DescriptionList } from '../components/DescriptionList'
import { PageHeader } from '../components/PageHeader'
import { ErrorBanner, PageLoader } from '../components/States'

const NUMBER_FIELDS = ['maxAttempts', 'retentionDays', 'statsRetentionDays'] as const

export function SettingsPage() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const origin = window.location.origin
  return (
    <>
      <PageHeader title="设置" />
      <div className="flex flex-col gap-4">
        {me.isPending ? <PageLoader /> : me.isError ? <ErrorBanner error={me.error} /> : <RuntimeSettingsForm initial={me.data} />}
        <LayerCard>
          <LayerCard.Secondary>
            <div className="flex flex-col">
              <span>接入</span>
              <Text size="xs" variant="secondary">
                HTTP 调用需要在「API Key」页创建的 Key；同账号下的 Worker 可以用 Service Binding 直接调用，不需要 Key。
              </Text>
            </div>
          </LayerCard.Secondary>
          <LayerCard.Primary className="flex flex-col gap-3">
            <Text size="sm" bold>
              HTTP
            </Text>
            <CodeBlock
              lang="bash"
              code={`curl -X POST ${origin}/api/send \\
  -H "Authorization: Bearer cfs_..." \\
  -H "Idempotency-Key: deploy-1234" \\
  -H "Content-Type: application/json" \\
  -d '{"channelGroup":"ops-alert","title":"部署失败","body":"**api** 回滚到 v1.2","format":"markdown","level":"error"}'`}
            />
            <Text size="sm" bold>
              Service Binding（RPC）
            </Text>
            <CodeBlock
              lang="ts"
              code={`// wrangler.jsonc
"services": [{ "binding": "SENDER", "service": "yunji-sender", "entrypoint": "SenderRpc" }]

// Worker 代码
await env.SENDER.send(
  { channelGroup: 'ops-alert', title: '任务失败', body: 'timeout after 25000ms', level: 'error' },
  { idempotencyKey: runId },
)`}
            />
          </LayerCard.Primary>
        </LayerCard>
        <LayerCard>
          <LayerCard.Secondary>
            <div className="flex flex-col">
              <span>后台认证</span>
              <Text size="xs" variant="secondary">
                认证配置来自 wrangler.jsonc 的 vars 和 secrets，修改后重新部署生效。
              </Text>
            </div>
          </LayerCard.Secondary>
          <LayerCard.Primary>
            {me.data ? (
              <DescriptionList
                items={[
                  ['后台认证', me.data.authMode === 'access' ? 'Cloudflare Access（ADMIN_AUTH_MODE=access）' : 'Basic 认证（ADMIN_AUTH_MODE=basic）'],
                  ['当前用户', me.data.user],
                ]}
              />
            ) : (
              <PageLoader />
            )}
          </LayerCard.Primary>
        </LayerCard>
      </div>
    </>
  )
}

function RuntimeSettingsForm({ initial }: { initial: AdminMe }) {
  const [mode, setMode] = useState(initial.executionMode)
  const [numbers, setNumbers] = useState(() =>
    Object.fromEntries(NUMBER_FIELDS.map((k) => [k, String(initial[k])])) as Record<(typeof NUMBER_FIELDS)[number], string>,
  )
  const [errors, setErrors] = useState<Partial<Record<keyof RuntimeSettings, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const toasts = useKumoToastManager()
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: () =>
      api.putRuntimeSettings({
        executionMode: mode,
        maxAttempts: Number(numbers.maxAttempts),
        retentionDays: Number(numbers.retentionDays),
        statsRetentionDays: Number(numbers.statsRetentionDays),
      }),
    onSuccess: (saved) => {
      qc.setQueryData<AdminMe>(['me'], (prev) => (prev ? { ...prev, ...saved } : prev))
      setErrors({})
      setError(null)
      toasts.add({ title: '运行设置已保存', variant: 'success' })
    },
    onError: (err) => {
      const fields: Partial<Record<keyof RuntimeSettings, string>> = {}
      if (err instanceof ApiError) for (const i of err.issues) fields[i.path as keyof RuntimeSettings] = i.message
      setErrors(fields)
      setError(Object.keys(fields).length ? '保存失败，请检查标出的字段。' : errorMessage(err))
    },
  })
  const numberInput = (key: (typeof NUMBER_FIELDS)[number], label: string, description: string) => (
    <Input
      label={label}
      type="number"
      inputMode="numeric"
      description={description}
      value={numbers[key]}
      onChange={(e) => setNumbers((n) => ({ ...n, [key]: e.target.value }))}
      {...(errors[key] ? { error: errors[key] } : {})}
    />
  )
  return (
    <LayerCard>
      <LayerCard.Secondary>
        <div className="flex flex-col">
          <span>运行设置</span>
          <Text size="xs" variant="secondary">
            保存后立即生效，无需重新部署。
          </Text>
        </div>
      </LayerCard.Secondary>
      <LayerCard.Primary>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <Radio.Group
            legend="投递方式"
            appearance="card"
            orientation="horizontal"
            value={mode}
            onValueChange={(v) => setMode(v as RuntimeSettings['executionMode'])}
            error={errors.executionMode}
            description="只影响之后的投递；已入队的消息按原方式完成。"
          >
            <Radio.Item
              label="队列"
              value="queue"
              disabled={!initial.queueAvailable && mode !== 'queue'}
              description={initial.queueAvailable ? '秒级重试和 12 小时内的定时发送；免费套餐也可用' : '当前部署没有配置 Queue'}
            />
            <Radio.Item label="直接发送" value="direct" description="请求内用 waitUntil 发送；重试和定时由每分钟的 Cron 处理" />
          </Radio.Group>
          <div className="grid gap-4 sm:grid-cols-3">
            {numberInput('maxAttempts', '最多尝试次数', '含首次，1–10；只有可重试的错误会重试')}
            {numberInput('retentionDays', '消息保留天数', '过期的消息和投递记录每小时清理')}
            {numberInput('statsRetentionDays', '统计保留天数', '按小时汇总的统计数据')}
          </div>
          {error && <Text variant="error">{error}</Text>}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={save.isPending}>
              保存
            </Button>
          </div>
        </form>
      </LayerCard.Primary>
    </LayerCard>
  )
}
