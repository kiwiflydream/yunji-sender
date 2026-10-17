import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Dialog,
  Empty,
  InlineCopyText,
  Input,
  LayerCard,
  Table,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import { HashIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { ChannelGroup } from '../../../src/shared/types'
import { api, ApiError, errorMessage, type ChannelGroupInput } from '../api'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { PageHeader } from '../components/PageHeader'
import { ErrorBanner, PageLoader } from '../components/States'

export function ChannelGroupsPage() {
  const channelGroups = useQuery({ queryKey: ['channelGroups'], queryFn: api.channelGroups })
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels })
  const [editing, setEditing] = useState<ChannelGroup | 'new' | null>(null)
  const [deleting, setDeleting] = useState<ChannelGroup | null>(null)
  const toasts = useKumoToastManager()
  const qc = useQueryClient()
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteChannelGroup(id),
    onSuccess: () => {
      toasts.add({ title: '渠道组已删除', variant: 'success' })
      setDeleting(null)
      qc.invalidateQueries({ queryKey: ['channelGroups'] })
      qc.invalidateQueries({ queryKey: ['channels'] })
    },
    onError: (err) => toasts.add({ title: '删除失败', description: errorMessage(err), variant: 'error' }),
  })
  const channelName = new Map((channels.data ?? []).map((c) => [c.id, c]))

  const addButton = (
    <Button variant="primary" icon={PlusIcon} onClick={() => setEditing('new')}>
      添加渠道组
    </Button>
  )

  return (
    <>
      <PageHeader
        title="渠道组"
        description="调用方只需指定渠道组，消息会扇出到渠道组绑定的所有已启用渠道；改接收人不用改代码。"
        actions={addButton}
      />
      {channelGroups.isPending ? (
        <PageLoader />
      ) : channelGroups.isError ? (
        <ErrorBanner error={channelGroups.error} />
      ) : channelGroups.data.length === 0 ? (
        <LayerCard className="py-12">
          <Empty
            icon={<HashIcon size={48} className="text-kumo-inactive" />}
            title="还没有渠道组"
            description="例如 ops-alert：绑定值班群和邮件，所有告警都发到这个渠道组。"
            contents={addButton}
          />
        </LayerCard>
      ) : (
        <LayerCard className="overflow-x-auto p-0">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>标识</Table.Head>
                <Table.Head>名称</Table.Head>
                <Table.Head>渠道</Table.Head>
                <Table.Head className="w-24" />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {channelGroups.data.map((t) => (
                <Table.Row key={t.id}>
                  <Table.Cell>
                    <InlineCopyText value={t.slug}>
                      <span className="font-mono">{t.slug}</span>
                    </InlineCopyText>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex flex-col">
                      <span>{t.name}</span>
                      {t.description && (
                        <Text size="xs" variant="secondary">
                          {t.description}
                        </Text>
                      )}
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    {t.channelIds.length ? (
                      <div className="flex flex-wrap gap-1">
                        {t.channelIds.map((id) => {
                          const c = channelName.get(id)
                          return (
                            <Badge key={id} variant={c?.enabled === false ? 'outline' : 'secondary'}>
                              {c?.name ?? id.slice(0, 8)}
                              {c?.enabled === false && '（停用）'}
                            </Badge>
                          )
                        })}
                      </div>
                    ) : (
                      <Text size="sm" variant="secondary">
                        未绑定渠道
                      </Text>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" shape="square" icon={PencilSimpleIcon} aria-label={`编辑 ${t.slug}`} onClick={() => setEditing(t)} />
                      <Button variant="ghost" size="sm" shape="square" icon={TrashIcon} aria-label={`删除 ${t.slug}`} onClick={() => setDeleting(t)} />
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
      {editing && <ChannelGroupDialog initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="删除渠道组"
        description={`确定删除 ${deleting?.slug}？之后发到这个渠道组的请求会返回 422。`}
        confirmLabel="删除"
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </>
  )
}

function ChannelGroupDialog({ initial, onClose }: { initial: ChannelGroup | null; onClose: () => void }) {
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels })
  const [form, setForm] = useState<ChannelGroupInput>({
    slug: initial?.slug ?? '',
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    channelIds: initial?.channelIds ?? [],
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const toasts = useKumoToastManager()
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: () => (initial ? api.updateChannelGroup(initial.id, form) : api.createChannelGroup(form)),
    onSuccess: () => {
      toasts.add({ title: initial ? '渠道组已保存' : '渠道组已添加', variant: 'success' })
      qc.invalidateQueries({ queryKey: ['channelGroups'] })
      qc.invalidateQueries({ queryKey: ['channels'] })
      onClose()
    },
    onError: (err) => {
      const fields: Record<string, string> = {}
      if (err instanceof ApiError) for (const i of err.issues) fields[i.path] = i.message
      setErrors(fields)
      setError(Object.keys(fields).length ? null : errorMessage(err))
    },
  })
  const set = <K extends keyof ChannelGroupInput>(k: K, v: ChannelGroupInput[K]) => setForm((f) => ({ ...f, [k]: v }))
  const err = (k: string) => (errors[k] ? { error: errors[k] } : {})

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog size="lg" className="max-h-[90svh] overflow-y-auto p-6">
        <Dialog.Title className="text-lg font-semibold">{initial ? `编辑 ${initial.slug}` : '添加渠道组'}</Dialog.Title>
        <form
          className="mt-4 flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <Input
            label="标识"
            className="font-mono"
            placeholder="ops-alert"
            description="调用 API 时用的 channelGroup，小写字母、数字、. _ -"
            value={form.slug}
            onChange={(e) => set('slug', e.target.value)}
            {...err('slug')}
          />
          <Input label="名称" placeholder="运维告警" value={form.name} onChange={(e) => set('name', e.target.value)} {...err('name')} />
          <Input label="描述（可选）" value={form.description} onChange={(e) => set('description', e.target.value)} />
          {channels.data?.length ? (
            <Checkbox.Group
              legend="渠道"
              description="停用的渠道会被跳过。"
              value={form.channelIds}
              onValueChange={(v) => set('channelIds', v)}
              error={errors.channelIds}
            >
              {channels.data.map((c) => (
                <Checkbox.Item key={c.id} value={c.id} label={c.enabled ? c.name : `${c.name}（停用）`} />
              ))}
            </Checkbox.Group>
          ) : (
            <Text variant="secondary">还没有渠道，可以先保存渠道组，之后再绑定。</Text>
          )}
          {error && <Banner variant="error" size="sm" description={error} />}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={(p) => <Button {...p}>取消</Button>} />
            <Button type="submit" variant="primary" loading={save.isPending}>
              保存
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
