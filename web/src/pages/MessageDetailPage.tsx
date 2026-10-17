import { Badge, Button, CodeBlock, Dialog, LayerCard, Table, Text, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowClockwiseIcon, ProhibitIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { Delivery } from '../../../src/shared/types'
import { api, ApiError, errorMessage } from '../api'
import { ChannelTypeBadge, DeliveryStatusBadge, LevelBadge, MessageStatusBadge } from '../components/badges'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { DescriptionList } from '../components/DescriptionList'
import { PageHeader } from '../components/PageHeader'
import { ErrorBanner, NotFound, PageLoader } from '../components/States'
import { fmtDuration, fmtRelative, fmtTime, SOURCE } from '../lib/format'

const PENDING = new Set(['scheduled', 'queued', 'sending'])

export function MessageDetailPage({ id }: { id: string }) {
  const message = useQuery({
    queryKey: ['message', id],
    queryFn: () => api.message(id),
    // Poll while anything is still in flight.
    refetchInterval: (q) => (q.state.data?.counts.pending ? 3_000 : false),
  })
  const [canceling, setCanceling] = useState(false)
  const [inspecting, setInspecting] = useState<Delivery | null>(null)
  const toasts = useKumoToastManager()
  const qc = useQueryClient()
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['message', id] })
    qc.invalidateQueries({ queryKey: ['messages'] })
  }
  const cancel = useMutation({
    mutationFn: () => api.cancelMessage(id),
    onSuccess: (n) => {
      toasts.add({ title: n ? `已取消 ${n} 个投递` : '没有可取消的投递', variant: n ? 'success' : 'info' })
      setCanceling(false)
      refresh()
    },
    onError: (err) => toasts.add({ title: '取消失败', description: errorMessage(err), variant: 'error' }),
  })
  const retry = useMutation({
    mutationFn: (deliveryId: string) => api.retryDelivery(deliveryId),
    onSuccess: () => {
      toasts.add({ title: '已重新投递', variant: 'success' })
      refresh()
    },
    onError: (err) => toasts.add({ title: '重试失败', description: errorMessage(err), variant: 'error' }),
  })

  if (message.isPending) return <PageLoader />
  if (message.isError) return message.error instanceof ApiError && message.error.status === 404 ? <NotFound /> : <ErrorBanner error={message.error} />
  const m = message.data
  const cancelable = m.deliveries.some((d) => d.status === 'scheduled' || d.status === 'queued')

  return (
    <>
      <PageHeader
        crumbs={[{ label: '消息', href: '/' }, { label: m.id.slice(0, 8) }]}
        title={m.title || '（无标题）'}
        badge={
          <>
            <MessageStatusBadge status={m.status} />
            <LevelBadge level={m.level} />
          </>
        }
        actions={
          cancelable && (
            <Button icon={ProhibitIcon} onClick={() => setCanceling(true)}>
              取消未开始的投递
            </Button>
          )
        }
      />
      <div className="flex flex-col gap-4">
        <LayerCard>
          <LayerCard.Secondary>投递</LayerCard.Secondary>
          <LayerCard.Primary className="overflow-x-auto p-0">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>渠道</Table.Head>
                  <Table.Head>状态</Table.Head>
                  <Table.Head className="text-right">尝试</Table.Head>
                  <Table.Head>时间</Table.Head>
                  <Table.Head className="text-right">耗时</Table.Head>
                  <Table.Head>结果</Table.Head>
                  <Table.Head className="w-28" />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {m.deliveries.map((d) => (
                  <Table.Row key={d.id}>
                    <Table.Cell>
                      <div className="flex items-center gap-2 whitespace-nowrap">
                        <span className="font-medium">{d.channelName}</span>
                        <ChannelTypeBadge type={d.channelType} />
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <DeliveryStatusBadge status={d.status} />
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">{d.attempts}</Table.Cell>
                    <Table.Cell className="whitespace-nowrap">
                      {d.finishedAt ? (
                        <span title={fmtTime(d.finishedAt)}>{fmtRelative(d.finishedAt)}</span>
                      ) : PENDING.has(d.status) ? (
                        <span title={fmtTime(d.nextAttemptAt)}>
                          {d.attempts > 0 ? '下次重试 ' : '计划 '}
                          {fmtRelative(d.nextAttemptAt)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">{fmtDuration(d.durationMs)}</Table.Cell>
                    <Table.Cell className="max-w-72">
                      <Text size="sm" variant={d.error ? 'error' : 'secondary'} truncate>
                        {d.error ?? (d.httpStatus ? `HTTP ${d.httpStatus}` : '—')}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex justify-end gap-1">
                        {(d.responseBody || d.error) && (
                          <Button variant="ghost" size="sm" onClick={() => setInspecting(d)}>
                            详情
                          </Button>
                        )}
                        {(d.status === 'failed' || d.status === 'canceled') && (
                          <Button
                            variant="ghost"
                            size="sm"
                            shape="square"
                            icon={ArrowClockwiseIcon}
                            aria-label={`重试 ${d.channelName}`}
                            title="重试"
                            loading={retry.isPending && retry.variables === d.id}
                            onClick={() => retry.mutate(d.id)}
                          />
                        )}
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </LayerCard.Primary>
        </LayerCard>

        <div className="grid items-start gap-4 lg:grid-cols-[1fr_20rem]">
          <LayerCard>
            <LayerCard.Secondary>内容</LayerCard.Secondary>
            <LayerCard.Primary className="flex flex-col gap-3">
              {m.content.body ? (
                <pre className="whitespace-pre-wrap break-words font-sans text-sm text-kumo-default">{m.content.body}</pre>
              ) : (
                <Text variant="secondary">（无正文）</Text>
              )}
              {Object.keys(m.content.raw).length > 0 && (
                <div className="flex flex-col gap-1">
                  <Text size="sm" bold>
                    raw 覆盖
                  </Text>
                  <CodeBlock lang="jsonc" code={JSON.stringify(m.content.raw, null, 2)} />
                </div>
              )}
            </LayerCard.Primary>
          </LayerCard>
          <LayerCard>
            <LayerCard.Secondary>属性</LayerCard.Secondary>
            <LayerCard.Primary>
              <DescriptionList
                items={[
                  ['ID', <span className="font-mono text-xs">{m.id}</span>],
                  ['主题', m.topicSlug ?? '—'],
                  ['来源', SOURCE[m.source]],
                  ['格式', m.content.format === 'markdown' ? 'Markdown' : '纯文本'],
                  ['发送时间', fmtTime(m.sendAt)],
                  ['创建时间', fmtTime(m.createdAt)],
                  ['链接', m.content.url ? <a className="text-kumo-link underline" href={m.content.url} target="_blank" rel="noreferrer">{m.content.url}</a> : '—'],
                  ['标签', m.content.tags.length ? <div className="flex flex-wrap gap-1">{m.content.tags.map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}</div> : '—'],
                ]}
              />
            </LayerCard.Primary>
          </LayerCard>
        </div>
      </div>

      <ConfirmDialog
        open={canceling}
        onOpenChange={setCanceling}
        title="取消投递"
        description="尚未开始的投递会被取消；正在发送或已完成的不受影响。"
        confirmLabel="取消投递"
        pending={cancel.isPending}
        onConfirm={() => cancel.mutate()}
      />
      {inspecting && (
        <Dialog.Root open onOpenChange={(open) => !open && setInspecting(null)}>
          <Dialog size="lg" className="p-6">
            <Dialog.Title className="text-lg font-semibold">
              {inspecting.channelName} · 第 {inspecting.attempts} 次尝试
            </Dialog.Title>
            <div className="mt-4 flex flex-col gap-3">
              <DescriptionList
                items={[
                  ['HTTP 状态', inspecting.httpStatus ?? '—'],
                  ['错误', inspecting.error ?? '—'],
                ]}
              />
              {inspecting.responseBody && <CodeBlock lang="jsonc" code={inspecting.responseBody} />}
            </div>
            <div className="mt-6 flex justify-end">
              <Dialog.Close render={(p) => <Button {...p}>关闭</Button>} />
            </div>
          </Dialog>
        </Dialog.Root>
      )}
    </>
  )
}
