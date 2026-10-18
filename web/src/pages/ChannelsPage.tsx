import { tr, useLocale } from '../i18n'
import { Badge, Button, Empty, LayerCard, Link, LinkButton, Table, Text, useKumoToastManager } from '@cloudflare/kumo'
import { PaperPlaneRightIcon, PlugsConnectedIcon, PlusIcon } from '@phosphor-icons/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { ChannelTestResult } from '../../../src/shared/types'
import { api, errorMessage } from '../api'
import { ChannelTypeBadge, EnabledBadge } from '../components/badges'
import { PageHeader } from '../components/PageHeader'
import { ErrorBanner, PageLoader } from '../components/States'
import { TestResultBanner } from '../components/TestResult'
import { fmtTime } from '../lib/format'

export function ChannelsPage() {
  useLocale()
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels })
  const [result, setResult] = useState<{ name: string; result: ChannelTestResult } | null>(null)
  const toasts = useKumoToastManager()
  const test = useMutation({
    mutationFn: (c: { id: string; name: string }) => api.testChannel(c.id).then((r) => ({ name: c.name, result: r })),
    onSuccess: setResult,
    onError: (err) => toasts.add({ title: tr('测试失败'), description: errorMessage(err), variant: 'error' }),
  })

  const addButton = (
    <LinkButton variant="primary" icon={PlusIcon} href="/channels/new">{tr('添加渠道')}</LinkButton>
  )

  return (
    <>
      <PageHeader title={tr('渠道')} description={tr('消息投递的目标：Webhook、IM 机器人、推送和邮件。凭证加密保存。')} actions={addButton} />
      {result && (
        <div className="mb-4">
          <TestResultBanner result={result.result} />
        </div>
      )}
      {channels.isPending ? (
        <PageLoader />
      ) : channels.isError ? (
        <ErrorBanner error={channels.error} />
      ) : channels.data.length === 0 ? (
        <LayerCard className="py-12">
          <Empty
            icon={<PlugsConnectedIcon size={48} className="text-kumo-inactive" />}
            title={tr('还没有渠道')}
            description={tr('先添加一个渠道，再把它绑定到渠道组。')}
            contents={addButton}
          />
        </LayerCard>
      ) : (
        <LayerCard className="overflow-x-auto p-0">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>{tr('名称')}</Table.Head>
                <Table.Head>{tr('类型')}</Table.Head>
                <Table.Head>{tr('状态')}</Table.Head>
                <Table.Head>{tr('渠道组')}</Table.Head>
                <Table.Head>{tr('更新时间')}</Table.Head>
                <Table.Head className="w-24" />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {channels.data.map((c) => (
                <Table.Row key={c.id}>
                  <Table.Cell>
                    <Link href={`/channels/${c.id}`} variant="plain" className="font-medium">
                      {c.name}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    <ChannelTypeBadge type={c.type} />
                  </Table.Cell>
                  <Table.Cell>
                    <EnabledBadge enabled={c.enabled} />
                  </Table.Cell>
                  <Table.Cell>
                    {c.channelGroupSlugs.length ? (
                      <div className="flex flex-wrap gap-1">
                        {c.channelGroupSlugs.map((s) => (
                          <Badge key={s} variant="secondary">
                            {s}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <Text size="sm" variant="secondary">{tr('未绑定')}</Text>
                    )}
                  </Table.Cell>
                  <Table.Cell className="whitespace-nowrap">{fmtTime(c.updatedAt)}</Table.Cell>
                  <Table.Cell>
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={PaperPlaneRightIcon}
                        loading={test.isPending && test.variables?.id === c.id}
                        onClick={() => test.mutate(c)}
                      >{tr('测试')}</Button>
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
    </>
  )
}
