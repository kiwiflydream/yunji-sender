import { Badge, Button, Empty, LayerCard, Link, LinkButton, Table, Text, useKumoToastManager } from '@cloudflare/kumo'
import { FileTextIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { MessageTemplate } from '../../../src/shared/types'
import { api, errorMessage } from '../api'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { PageHeader } from '../components/PageHeader'
import { ErrorBanner, PageLoader } from '../components/States'

export function TemplatesPage() {
  const templates = useQuery({ queryKey: ['templates'], queryFn: api.templates })
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels })
  const [deleting, setDeleting] = useState<MessageTemplate | null>(null)
  const qc = useQueryClient()
  const toasts = useKumoToastManager()
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteTemplate(id),
    onSuccess: () => {
      setDeleting(null)
      qc.invalidateQueries({ queryKey: ['templates'] })
      toasts.add({ title: '模板已删除', variant: 'success' })
    },
    onError: (error) => toasts.add({ title: '删除失败', description: errorMessage(error), variant: 'error' }),
  })
  const add = <LinkButton href="/templates/new" variant="primary" icon={PlusIcon}>创建模板</LinkButton>
  const channelNames = new Map(channels.data?.map((c) => [c.id, c.name]))
  return (
    <>
      <PageHeader title="消息模板" description="保存通知文案和发送目标，调用时只传模板 ID 和变量。内置模板可直接编辑使用。" actions={add} />
      {templates.isPending ? <PageLoader /> : templates.isError ? <ErrorBanner error={templates.error} /> : templates.data.length === 0 ? (
        <LayerCard className="py-12"><Empty icon={<FileTextIcon size={48} />} title="还没有模板" description="把常用通知保存为模板，业务系统只需传入变化的数据。" contents={add} /></LayerCard>
      ) : (
        <LayerCard className="overflow-x-auto p-0">
          <Table>
            <Table.Header><Table.Row><Table.Head>名称 / 模板 ID</Table.Head><Table.Head>变量</Table.Head><Table.Head>默认发送目标</Table.Head><Table.Head className="w-20" /></Table.Row></Table.Header>
            <Table.Body>{templates.data.map((template) => (
              <Table.Row key={template.id}>
                <Table.Cell><Link href={`/templates/${template.id}`} variant="plain" className="font-medium">{template.name}</Link><div className="mt-1 font-mono text-xs text-kumo-subtle">{template.id}</div></Table.Cell>
                <Table.Cell><div className="flex flex-wrap gap-1">{template.variables.length ? template.variables.map((key) => <Badge key={key} variant="secondary">{key}</Badge>) : <Text size="sm" variant="secondary">无变量</Text>}</div></Table.Cell>
                <Table.Cell><div className="flex flex-wrap gap-1">
                  {template.channelGroup && <Badge variant="secondary">渠道组：{template.channelGroup}</Badge>}
                  {template.channels.map((id) => <Badge key={id} variant="secondary">{channelNames.get(id) ?? '渠道已删除'}</Badge>)}
                  {!template.channelGroup && !template.channels.length && <Text size="sm" variant="secondary">待配置，可在发送时指定</Text>}
                </div></Table.Cell>
                <Table.Cell><Button variant="ghost" size="sm" shape="square" icon={TrashIcon} aria-label={`删除 ${template.name}`} onClick={() => setDeleting(template)} /></Table.Cell>
              </Table.Row>
            ))}</Table.Body>
          </Table>
        </LayerCard>
      )}
      <ConfirmDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)} title="删除模板"
        description={`确定删除 ${deleting?.name}？之后使用此模板 ID 的调用将失败，已提交的消息不受影响。`}
        confirmLabel="删除" pending={remove.isPending} onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </>
  )
}
