import { Button, Empty, LayerCard, Link, Select, Table, Text } from '@cloudflare/kumo'
import { PaperPlaneTiltIcon, TrayIcon } from '@phosphor-icons/react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { MessageStatus } from '../../../src/shared/types'
import { api, type MessageFilter } from '../api'
import { LevelBadge, MessageStatusBadge } from '../components/badges'
import { PageHeader } from '../components/PageHeader'
import { SendDialog } from '../components/SendDialog'
import { ErrorBanner, PageLoader } from '../components/States'
import { fmtRelative, fmtTime, MESSAGE_STATUS, SOURCE } from '../lib/format'

const ALL = '__all__'

export function MessagesPage() {
  const [filter, setFilter] = useState<MessageFilter>({})
  const [sending, setSending] = useState(false)
  const topics = useQuery({ queryKey: ['topics'], queryFn: api.topics })
  const messages = useInfiniteQuery({
    queryKey: ['messages', filter],
    queryFn: ({ pageParam }) => api.messages(filter, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: 5_000,
  })
  const rows = messages.data?.pages.flatMap((p) => p.messages) ?? []
  const filtered = !!(filter.status || filter.topic)

  const sendButton = (
    <Button variant="primary" icon={PaperPlaneTiltIcon} onClick={() => setSending(true)}>
      发送消息
    </Button>
  )

  return (
    <>
      <PageHeader title="消息" description="所有发送请求及其在各渠道的投递结果。" actions={sendButton} />
      <div className="mb-4 flex flex-wrap gap-3">
        <Select
          aria-label="状态"
          className="w-36"
          value={filter.status ?? ALL}
          onValueChange={(v) => setFilter((f) => ({ ...f, status: v === ALL ? undefined : (v as MessageStatus) }))}
          items={{ [ALL]: '全部状态', ...Object.fromEntries(Object.entries(MESSAGE_STATUS).map(([k, v]) => [k, v.label])) }}
        >
          <Select.Option value={ALL}>全部状态</Select.Option>
          {Object.entries(MESSAGE_STATUS).map(([k, v]) => (
            <Select.Option key={k} value={k}>
              {v.label}
            </Select.Option>
          ))}
        </Select>
        <Select
          aria-label="主题"
          className="w-48"
          value={filter.topic ?? ALL}
          onValueChange={(v) => setFilter((f) => ({ ...f, topic: v === ALL ? undefined : String(v) }))}
          items={{ [ALL]: '全部主题', ...Object.fromEntries((topics.data ?? []).map((t) => [t.slug, t.slug])) }}
        >
          <Select.Option value={ALL}>全部主题</Select.Option>
          {(topics.data ?? []).map((t) => (
            <Select.Option key={t.id} value={t.slug}>
              {t.slug}
            </Select.Option>
          ))}
        </Select>
      </div>
      {messages.isPending ? (
        <PageLoader />
      ) : messages.isError ? (
        <ErrorBanner error={messages.error} />
      ) : rows.length === 0 ? (
        <LayerCard className="py-12">
          <Empty
            icon={<TrayIcon size={48} className="text-kumo-inactive" />}
            title={filtered ? '没有符合条件的消息' : '还没有消息'}
            description={filtered ? '换个筛选条件试试。' : '通过 API、RPC 或这里的「发送消息」发出第一条通知。'}
            contents={filtered ? undefined : sendButton}
          />
        </LayerCard>
      ) : (
        <LayerCard className="overflow-x-auto p-0">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>时间</Table.Head>
                <Table.Head>标题</Table.Head>
                <Table.Head>主题</Table.Head>
                <Table.Head className="text-right">送达</Table.Head>
                <Table.Head>状态</Table.Head>
                <Table.Head>来源</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((m) => (
                <Table.Row key={m.id}>
                  <Table.Cell className="whitespace-nowrap" title={fmtTime(m.createdAt)}>
                    {m.status === 'scheduled' ? `定时 ${fmtTime(m.sendAt)}` : fmtRelative(m.createdAt)}
                  </Table.Cell>
                  <Table.Cell className="max-w-80">
                    <div className="flex items-center gap-2">
                      <Link href={`/messages/${m.id}`} variant="plain" className="truncate font-medium">
                        {m.title || <span className="text-kumo-subtle">（无标题）</span>}
                      </Link>
                      <LevelBadge level={m.level} />
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="sm" variant="secondary">
                      {m.topicSlug ?? '—'}
                    </Text>
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums">
                    {m.counts.sent}/{m.counts.total}
                  </Table.Cell>
                  <Table.Cell>
                    <MessageStatusBadge status={m.status} />
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="sm" variant="secondary">
                      {SOURCE[m.source]}
                    </Text>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
          {messages.hasNextPage && (
            <div className="flex justify-center border-t border-kumo-hairline p-3">
              <Button variant="ghost" loading={messages.isFetchingNextPage} onClick={() => messages.fetchNextPage()}>
                加载更多
              </Button>
            </div>
          )}
        </LayerCard>
      )}
      {sending && <SendDialog onClose={() => setSending(false)} />}
    </>
  )
}
