import { Chart, ChartLegend, ChartPalette, LayerCard, Surface, Table, Tabs, Text, type KumoChartOption } from '@cloudflare/kumo'
import { CheckCircleIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { useState, type ReactNode } from 'react'
import { formatInZone } from '../../../src/lib/time'
import type { StatsBreakdownRow, StatsOverview, StatsRange, StatsSummary } from '../../../src/shared/types'
import { statusColors, surfaceColor, useDarkMode } from '../lib/chart-colors'
import { echarts } from '../lib/echarts'
import { fmtBucket, fmtCount, fmtDuration, fmtPercent, viewerTimezone } from '../lib/format'
import { ChannelTypeBadge } from './badges'

const RANGES: { value: StatsRange; label: string }[] = [
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: '90d', label: '90 天' },
]

export function RangeTabs({ value, onChange }: { value: StatsRange; onChange: (r: StatsRange) => void }) {
  return <Tabs variant="segmented" size="sm" value={value} onValueChange={(v) => onChange(v as StatsRange)} tabs={RANGES} />
}

const CHART_HEIGHT = 240
export const STATS_REFRESH_MS = 60_000

function Kpi({ label, value, hint, icon }: { label: string; value: string; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <Surface className="flex flex-col gap-1 rounded-lg p-4">
      <Text size="sm" variant="secondary">
        {label}
      </Text>
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-2xl font-semibold tabular-nums text-kumo-default">{value}</span>
      </div>
      {hint && (
        <Text size="xs" variant="secondary">
          {hint}
        </Text>
      )}
    </Surface>
  )
}

export function KpiTiles({ summary: s }: { summary: StatsSummary }) {
  const status = statusColors(useDarkMode())
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Kpi label="投递次数" value={fmtCount(s.total)} hint={`送达 ${fmtCount(s.sent)} · 失败 ${fmtCount(s.failed)}`} />
      <Kpi
        label="送达率"
        value={fmtPercent(s.successRate)}
        icon={
          s.total === 0 ? undefined : s.failed === 0 ? (
            <CheckCircleIcon size={20} weight="fill" color={status.success} aria-label="全部送达" />
          ) : (
            <WarningCircleIcon size={20} weight="fill" color={status.failed} aria-label="有失败" />
          )
        }
        hint="送达 ÷（送达 + 最终失败）"
      />
      <Kpi label="平均送达延迟" value={fmtDuration(s.latencyAvg)} hint={`最大 ${fmtDuration(s.latencyMax)} · 从计划发送时间算起`} />
      <Kpi label="重试次数" value={fmtCount(s.retries)} hint="首次之后的额外尝试" />
    </div>
  )
}

const DATA_END = [4, 4, 0, 0]

export function ResultsChart({ stats }: { stats: StatsOverview }) {
  const dark = useDarkMode()
  const status = statusColors(dark)
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const tick = (ms: number) =>
    stats.range === '24h' ? formatInZone(ms, viewerTimezone).slice(11, 16) : formatInZone(ms, viewerTimezone).slice(5, 10)
  const text = ChartPalette.text('secondary', dark)
  const segment = { borderColor: surfaceColor(dark), borderWidth: stats.series.length > 60 ? 1 : 2 }
  const options: KumoChartOption = {
    backgroundColor: 'transparent',
    aria: { enabled: true, label: { description: `送达 ${stats.summary.sent} 次，失败 ${stats.summary.failed} 次` } },
    grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: stats.series.map((p) => fmtBucket(p.t, stats.granularity)),
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        color: text,
        hideOverlap: true,
        ...(stats.range === '7d'
          ? { interval: (i: number) => formatInZone(stats.series[i].t, viewerTimezone).slice(11, 13) === '00' }
          : {}),
        formatter: (_: string, i: number) => tick(stats.series[i].t),
      },
    },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { color: text }, splitLine: { lineStyle: { opacity: 0.25, type: 'dashed' } } },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => `${fmtCount(Number(v))} 次` },
    series: [
      {
        type: 'bar',
        name: '送达',
        stack: 'deliveries',
        barCategoryGap: '20%',
        itemStyle: { ...segment, color: status.success },
        data: stats.series.map((p) => ({ value: p.sent, itemStyle: { borderRadius: p.failed > 0 ? 0 : DATA_END } })),
      },
      {
        type: 'bar',
        name: '失败',
        stack: 'deliveries',
        itemStyle: { ...segment, color: status.failed, borderRadius: DATA_END },
        data: stats.series.map((p) => p.failed),
      },
    ],
  }
  const rows = stats.series.filter((p) => p.sent + p.failed > 0).reverse()
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-start justify-between gap-3">
        <div className="flex flex-col">
          <span>投递结果</span>
          <Text size="xs" variant="secondary">
            每{stats.granularity === 'hour' ? '小时' : '天'}的最终结果，按计划发送时间归档
          </Text>
        </div>
        <Tabs
          variant="segmented"
          size="sm"
          value={view}
          onValueChange={(v) => setView(v as 'chart' | 'table')}
          tabs={[
            { value: 'chart', label: '图表' },
            { value: 'table', label: '表格' },
          ]}
        />
      </LayerCard.Secondary>
      <LayerCard.Primary>
        {view === 'chart' ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <ChartLegend.SmallItem name="送达" color={status.success} value={fmtCount(stats.summary.sent)} />
              <ChartLegend.SmallItem name="失败" color={status.failed} value={fmtCount(stats.summary.failed)} />
            </div>
            <Chart echarts={echarts} isDarkMode={dark} height={CHART_HEIGHT} options={options} />
          </div>
        ) : rows.length === 0 ? (
          <Text size="sm" variant="secondary">
            暂无数据
          </Text>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>时间</Table.Head>
                  <Table.Head className="text-right">送达</Table.Head>
                  <Table.Head className="text-right">失败</Table.Head>
                  <Table.Head className="text-right">平均延迟</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((p) => (
                  <Table.Row key={p.t}>
                    <Table.Cell className="whitespace-nowrap">{fmtBucket(p.t, stats.granularity)}</Table.Cell>
                    <Table.Cell className="text-right tabular-nums">{fmtCount(p.sent)}</Table.Cell>
                    <Table.Cell className="text-right tabular-nums">{fmtCount(p.failed)}</Table.Cell>
                    <Table.Cell className="text-right tabular-nums">{fmtDuration(p.latencyAvg)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </LayerCard.Primary>
    </LayerCard>
  )
}

export function Breakdown({ title, column, rows, empty }: { title: string; column: string; rows: StatsBreakdownRow[]; empty: string }) {
  return (
    <LayerCard className="p-0">
      <LayerCard.Secondary>{title}</LayerCard.Secondary>
      <LayerCard.Primary className="overflow-x-auto p-0">
        {rows.length === 0 ? (
          <div className="p-4">
            <Text size="sm" variant="secondary">
              {empty}
            </Text>
          </div>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>{column}</Table.Head>
                <Table.Head className="text-right">投递</Table.Head>
                <Table.Head className="text-right">失败</Table.Head>
                <Table.Head className="text-right">送达率</Table.Head>
                <Table.Head className="text-right">平均延迟</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((r) => (
                <Table.Row key={r.key || '_'}>
                  <Table.Cell className="max-w-56">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{r.label}</span>
                      {r.type && <ChannelTypeBadge type={r.type} />}
                    </div>
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums">{fmtCount(r.total)}</Table.Cell>
                  <Table.Cell className="text-right tabular-nums">{fmtCount(r.failed)}</Table.Cell>
                  <Table.Cell className="text-right tabular-nums">{fmtPercent(r.successRate)}</Table.Cell>
                  <Table.Cell className="text-right tabular-nums">{fmtDuration(r.latencyAvg)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </LayerCard.Primary>
    </LayerCard>
  )
}
