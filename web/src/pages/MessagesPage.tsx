import { tr, useLocale } from '../i18n'
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
  useLocale()
  const [filter, setFilter] = useState<MessageFilter>({})
  const [sending, setSending] = useState(false)
  const channelGroups = useQuery({ queryKey: ['channelGroups'], queryFn: api.channelGroups })
  const messages = useInfiniteQuery({
    queryKey: ['messages', filter],
    queryFn: ({ pageParam }) => api.messages(filter, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    // Infinite queries refetch every loaded page. Keep the live first page
    // responsive, but refresh history less often as the list grows.
    refetchInterval: (q) => {
      const pages = q.state.data?.pages ?? []
      const active = pages.some((p) => p.messages.some((m) => m.counts.pending > 0))
      return (active ? 5_000 : 30_000) * Math.max(1, pages.length)
    },
  })
  const rows = messages.data?.pages.flatMap((p) => p.messages) ?? []
  const filtered = !!(filter.status || filter.channelGroup)

  const sendButton = (
    <Button variant="primary" icon={PaperPlaneTiltIcon} onClick={() => setSending(true)}>{tr('发送消息')}</Button>
  )

  return (
    <>
      <PageHeader title={tr('消息')} description={tr('所有发送请求及其在各渠道的投递结果。')} actions={sendButton} />
      <div className="mb-4 flex flex-wrap gap-3">
        <Select
          aria-label={tr('状态')}
          className="w-36"
          value={filter.status ?? ALL}
          onValueChange={(v) => setFilter((f) => ({ ...f, status: v === ALL ? undefined : (v as MessageStatus) }))}
          items={{ [ALL]: tr('全部状态'), ...Object.fromEntries(Object.entries(MESSAGE_STATUS).map(([k, v]) => [k, tr(v.label)])) }}
        >
          <Select.Option value={ALL}>{tr('全部状态')}</Select.Option>
          {Object.entries(MESSAGE_STATUS).map(([k, v]) => (
            <Select.Option key={k} value={k}>
              {tr(v.label)}
            </Select.Option>
          ))}
        </Select>
        <Select
          aria-label={tr('渠道组')}
          className="w-48"
          value={filter.channelGroup ?? ALL}
          onValueChange={(v) => setFilter((f) => ({ ...f, channelGroup: v === ALL ? undefined : String(v) }))}
          items={{ [ALL]: tr('全部渠道组'), ...Object.fromEntries((channelGroups.data ?? []).map((t) => [t.slug, t.slug])) }}
        >
          <Select.Option value={ALL}>{tr('全部渠道组')}</Select.Option>
          {(channelGroups.data ?? []).map((t) => (
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
            title={filtered ? tr('没有符合条件的消息') : tr('还没有消息')}
            description={filtered ? tr('换个筛选条件试试。') : tr('通过 API、RPC 或这里的「发送消息」发出第一条通知。')}
            contents={filtered ? undefined : sendButton}
          />
        </LayerCard>
      ) : (
        <LayerCard className="overflow-x-auto p-0">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>{tr('时间')}</Table.Head>
                <Table.Head>{tr('标题')}</Table.Head>
                <Table.Head>{tr('渠道组')}</Table.Head>
                <Table.Head className="text-right">{tr('送达')}</Table.Head>
                <Table.Head>{tr('状态')}</Table.Head>
                <Table.Head>{tr('来源')}</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((m) => (
                <Table.Row key={m.id}>
                  <Table.Cell className="whitespace-nowrap" title={fmtTime(m.createdAt)}>
                    {m.status === 'scheduled' ? tr('定时 {%value0%}', { value0: fmtTime(m.sendAt) }) : fmtRelative(m.createdAt)}
                  </Table.Cell>
                  <Table.Cell className="max-w-80">
                    <div className="flex items-center gap-2">
                      <Link href={`/messages/${m.id}`} variant="plain" className="truncate font-medium">
                        {m.title || <span className="text-kumo-subtle">{tr('（无标题）')}</span>}
                      </Link>
                      <LevelBadge level={m.level} />
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="sm" variant="secondary">
                      {m.channelGroupSlug ?? '—'}
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
                      {tr(SOURCE[m.source])}
                    </Text>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
          {messages.hasNextPage && (
            <div className="flex justify-center border-t border-kumo-hairline p-3">
              <Button variant="ghost" loading={messages.isFetchingNextPage} onClick={() => messages.fetchNextPage()}>{tr('加载更多')}</Button>
            </div>
          )}
        </LayerCard>
      )}
      {sending && <SendDialog onClose={() => setSending(false)} />}
    </>
  )
}
