import { tr, useLocale } from '../i18n'
import { Button, CodeBlock, Input, LayerCard, Radio, Text, useKumoToastManager } from '@cloudflare/kumo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { AdminMe, RuntimeSettings } from '../../../src/shared/types'
import { api, ApiError, errorMessage, issueMessage } from '../api'
import { DescriptionList } from '../components/DescriptionList'
import { PageHeader } from '../components/PageHeader'
import { ErrorBanner, PageLoader } from '../components/States'

const NUMBER_FIELDS = ['maxAttempts', 'retentionDays', 'statsRetentionDays'] as const

export function SettingsPage() {
  const { locale, setLocale } = useLocale()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const origin = window.location.origin
  return (
    <>
      <PageHeader title={tr('设置')} />
      <div className="flex flex-col gap-4">
        <LayerCard>
          <LayerCard.Secondary><Text bold>{tr('界面语言')}</Text></LayerCard.Secondary>
          <LayerCard.Primary>
            <Radio.Group legend={tr('界面语言')} description={tr('自动识别浏览器语言，也可以手动选择。选择会保存在当前浏览器。')}
              value={locale} onValueChange={(value) => setLocale(value === 'en' ? 'en' : 'zh-CN')}>
              <Radio.Item value="zh-CN" label="简体中文" />
              <Radio.Item value="en" label="English" />
            </Radio.Group>
          </LayerCard.Primary>
        </LayerCard>
        {me.isPending ? <PageLoader /> : me.isError ? <ErrorBanner error={me.error} /> : <RuntimeSettingsForm initial={me.data} />}
        <LayerCard>
          <LayerCard.Secondary>
            <div className="flex flex-col">
              <span>{tr('接入')}</span>
              <Text size="xs" variant="secondary">{tr('HTTP 调用需要在「API Key」页创建的 Key；同账号下的 Worker 可以用 Service Binding 直接调用，不需要 Key。')}</Text>
            </div>
          </LayerCard.Secondary>
          <LayerCard.Primary className="flex flex-col gap-3">
            <Text size="sm" bold>
              HTTP
            </Text>
            <CodeBlock
              lang="bash"
              code={tr('curl -X POST {%value0%}/api/send \\\n  -H "Authorization: Bearer cfs_..." \\\n  -H "Idempotency-Key: deploy-1234" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"channelGroup":"ops-alert","title":"部署失败","body":"**api** 回滚到 v1.2","format":"markdown","level":"error"}\'', { value0: origin })}
            />
            <Text size="sm" bold>{tr('Service Binding（RPC）')}</Text>
            <CodeBlock
              lang="ts"
              code={tr('// wrangler.jsonc\n"services": [{ "binding": "SENDER", "service": "yunji-sender", "entrypoint": "SenderRpc" }]\n\n// Worker 代码\nawait env.SENDER.send(\n  { channelGroup: \'ops-alert\', title: \'任务失败\', body: \'timeout after 25000ms\', level: \'error\' },\n  { idempotencyKey: runId },\n)')}
            />
          </LayerCard.Primary>
        </LayerCard>
        <LayerCard>
          <LayerCard.Secondary>
            <div className="flex flex-col">
              <span>{tr('后台认证')}</span>
              <Text size="xs" variant="secondary">{tr('认证配置来自 wrangler.jsonc 的 vars 和 secrets，修改后重新部署生效。')}</Text>
            </div>
          </LayerCard.Secondary>
          <LayerCard.Primary>
            {me.data ? (
              <DescriptionList
                items={[
                  [tr('后台认证'), me.data.authMode === 'access' ? tr('Cloudflare Access（ADMIN_AUTH_MODE=access）') : tr('Basic 认证（ADMIN_AUTH_MODE=basic）')],
                  [tr('当前用户'), me.data.user],
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
  useLocale()
  const [mode, setMode] = useState(initial.executionMode)
  const [numbers, setNumbers] = useState(() =>
    Object.fromEntries(NUMBER_FIELDS.map((k) => [k, String(initial[k])])) as Record<(typeof NUMBER_FIELDS)[number], string>,
  )
  const [errors, setErrors] = useState<Partial<Record<keyof RuntimeSettings, string>>>({})
  const [error, setError] = useState<Error | string | null>(null)
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
      toasts.add({ title: tr('运行设置已保存'), variant: 'success' })
    },
    onError: (err) => {
      const fields: Partial<Record<keyof RuntimeSettings, string>> = {}
      if (err instanceof ApiError) for (const i of err.issues) fields[i.path as keyof RuntimeSettings] = i.message
      setErrors(fields)
      setError(Object.keys(fields).length ? '保存失败，请检查标出的字段。' : err)
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
      {...(errors[key] ? { error: issueMessage(errors[key]) } : {})}
    />
  )
  return (
    <LayerCard>
      <LayerCard.Secondary>
        <div className="flex flex-col">
          <span>{tr('运行设置')}</span>
          <Text size="xs" variant="secondary">{tr('保存后立即生效，无需重新部署。')}</Text>
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
            legend={tr('投递方式')}
            appearance="card"
            orientation="horizontal"
            value={mode}
            onValueChange={(v) => setMode(v as RuntimeSettings['executionMode'])}
            error={issueMessage(errors.executionMode)}
            description={tr('只影响之后的投递；已入队的消息按原方式完成。')}
          >
            <Radio.Item
              label={tr('队列')}
              value="queue"
              disabled={!initial.queueAvailable && mode !== 'queue'}
              description={initial.queueAvailable ? tr('秒级重试和 12 小时内的定时发送；免费套餐也可用') : tr('当前部署没有配置 Queue')}
            />
            <Radio.Item label={tr('直接发送')} value="direct" description={tr('请求内用 waitUntil 发送；重试和定时由每分钟的 Cron 处理')} />
          </Radio.Group>
          <div className="grid gap-4 sm:grid-cols-3">
            {numberInput('maxAttempts', tr('最多尝试次数'), tr('含首次，1–10；只有可重试的错误会重试'))}
            {numberInput('retentionDays', tr('消息保留天数'), tr('过期的消息和投递记录每小时清理'))}
            {numberInput('statsRetentionDays', tr('统计保留天数'), tr('按小时汇总的统计数据'))}
          </div>
          {error && <Text variant="error">{errorMessage(error)}</Text>}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={save.isPending}>{tr('保存')}</Button>
          </div>
        </form>
      </LayerCard.Primary>
    </LayerCard>
  )
}
