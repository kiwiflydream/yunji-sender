import { tr, useLocale } from '../i18n'
import { Empty, LayerCard } from '@cloudflare/kumo'
import { ChartBarIcon } from '@phosphor-icons/react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { StatsRange } from '../../../src/shared/types'
import { api } from '../api'
import { PageHeader } from '../components/PageHeader'
import { ErrorBanner, PageLoader } from '../components/States'
import { Breakdown, KpiTiles, RangeTabs, ResultsChart, STATS_REFRESH_MS } from '../components/stats'

export default function StatsPage() {
  useLocale()
  const [range, setRange] = useState<StatsRange>('24h')
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const stats = useQuery({
    queryKey: ['stats', range],
    queryFn: () => api.stats(range),
    placeholderData: keepPreviousData,
    refetchInterval: STATS_REFRESH_MS,
  })

  return (
    <>
      <PageHeader
        title={tr('统计')}
        description={tr('各渠道、各渠道组的投递结果，按小时汇总{%value0%}。', { value0: me.data ? tr('，保留 {%value0%} 天', { value0: me.data.statsRetentionDays }) : '' })}
        actions={<RangeTabs value={range} onChange={setRange} />}
      />
      {stats.isPending ? (
        <PageLoader />
      ) : stats.isError ? (
        <ErrorBanner error={stats.error} />
      ) : stats.data.summary.total === 0 ? (
        <LayerCard className="py-12">
          <Empty icon={<ChartBarIcon size={48} className="text-kumo-inactive" />} title={tr('这段时间没有投递')} description={tr('投递完成后，这里会出现图表。')} />
        </LayerCard>
      ) : (
        <div className={`flex flex-col gap-4 transition-opacity ${stats.isPlaceholderData ? 'opacity-60' : ''}`}>
          <KpiTiles summary={stats.data.summary} />
          <ResultsChart stats={stats.data} />
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <Breakdown title={tr('按渠道')} column={tr('渠道')} rows={stats.data.byChannel} empty={tr('暂无数据')} />
            <Breakdown title={tr('按渠道组')} column={tr('渠道组')} rows={stats.data.byChannelGroup} empty={tr('暂无数据')} />
          </div>
        </div>
      )}
    </>
  )
}
