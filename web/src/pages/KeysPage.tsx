import {
  Badge,
  Banner,
  Button,
  Checkbox,
  ClipboardText,
  Dialog,
  Empty,
  Input,
  LayerCard,
  Switch,
  Table,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import { KeyIcon, PlusIcon, ProhibitIcon, TrashIcon, WarningIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { ApiKeyInfo } from '../../../src/shared/types'
import { api, ApiError, errorMessage } from '../api'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { PageHeader } from '../components/PageHeader'
import { ErrorBanner, PageLoader } from '../components/States'
import { fmtRelative, fmtTime } from '../lib/format'

export function KeysPage() {
  const keys = useQuery({ queryKey: ['keys'], queryFn: api.keys })
  const [creating, setCreating] = useState(false)
  const [confirm, setConfirm] = useState<{ key: ApiKeyInfo; action: 'revoke' | 'delete' } | null>(null)
  const toasts = useKumoToastManager()
  const qc = useQueryClient()
  const act = useMutation({
    mutationFn: (c: NonNullable<typeof confirm>) => (c.action === 'revoke' ? api.revokeKey(c.key.id) : api.deleteKey(c.key.id)),
    onSuccess: (_, c) => {
      toasts.add({ title: c.action === 'revoke' ? 'Key 已吊销' : 'Key 已删除', variant: 'success' })
      setConfirm(null)
      qc.invalidateQueries({ queryKey: ['keys'] })
    },
    onError: (err) => toasts.add({ title: '操作失败', description: errorMessage(err), variant: 'error' }),
  })

  const addButton = (
    <Button variant="primary" icon={PlusIcon} onClick={() => setCreating(true)}>
      创建 Key
    </Button>
  )

  return (
    <>
      <PageHeader title="API Key" description="调用 POST /api/send 用的 Bearer Token。可以限定只能发送到指定渠道组。" actions={addButton} />
      {keys.isPending ? (
        <PageLoader />
      ) : keys.isError ? (
        <ErrorBanner error={keys.error} />
      ) : keys.data.length === 0 ? (
        <LayerCard className="py-12">
          <Empty
            icon={<KeyIcon size={48} className="text-kumo-inactive" />}
            title="还没有 API Key"
            description="为每个调用方单独创建一个 Key，方便区分来源和单独吊销。"
            contents={addButton}
          />
        </LayerCard>
      ) : (
        <LayerCard className="overflow-x-auto p-0">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>名称</Table.Head>
                <Table.Head>Key</Table.Head>
                <Table.Head>可用渠道组</Table.Head>
                <Table.Head>最后使用</Table.Head>
                <Table.Head>创建时间</Table.Head>
                <Table.Head className="w-24" />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {keys.data.map((k) => (
                <Table.Row key={k.id}>
                  <Table.Cell>
                    <div className="flex items-center gap-2">
                      <span className={k.revokedAt ? 'text-kumo-subtle line-through' : 'font-medium'}>{k.name}</span>
                      {k.revokedAt && <Badge variant="neutral">已吊销</Badge>}
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <span className="font-mono text-sm text-kumo-subtle">{k.prefix}…</span>
                  </Table.Cell>
                  <Table.Cell>
                    {k.channelGroups === null ? (
                      <Text size="sm" variant="secondary">
                        不限（含直接指定渠道）
                      </Text>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {k.channelGroups.map((t) => (
                          <Badge key={t} variant="secondary">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </Table.Cell>
                  <Table.Cell className="whitespace-nowrap" title={fmtTime(k.lastUsedAt)}>
                    {k.lastUsedAt ? fmtRelative(k.lastUsedAt) : '从未'}
                  </Table.Cell>
                  <Table.Cell className="whitespace-nowrap">{fmtTime(k.createdAt)}</Table.Cell>
                  <Table.Cell>
                    <div className="flex justify-end gap-1">
                      {!k.revokedAt && (
                        <Button variant="ghost" size="sm" shape="square" icon={ProhibitIcon} aria-label={`吊销 ${k.name}`} title="吊销" onClick={() => setConfirm({ key: k, action: 'revoke' })} />
                      )}
                      <Button variant="ghost" size="sm" shape="square" icon={TrashIcon} aria-label={`删除 ${k.name}`} title="删除" onClick={() => setConfirm({ key: k, action: 'delete' })} />
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
      {creating && <CreateKeyDialog onClose={() => setCreating(false)} />}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm?.action === 'revoke' ? '吊销 Key' : '删除 Key'}
        description={
          confirm?.action === 'revoke'
            ? `吊销后 ${confirm.key.name} 立即失效，记录保留。`
            : `删除 ${confirm?.key.name}？如果还在使用，调用会立即返回 401。`
        }
        confirmLabel={confirm?.action === 'revoke' ? '吊销' : '删除'}
        pending={act.isPending}
        onConfirm={() => confirm && act.mutate(confirm)}
      />
    </>
  )
}

function CreateKeyDialog({ onClose }: { onClose: () => void }) {
  const channelGroups = useQuery({ queryKey: ['channelGroups'], queryFn: api.channelGroups })
  const [name, setName] = useState('')
  const [restricted, setRestricted] = useState(false)
  const [allowed, setAllowed] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  const qc = useQueryClient()
  const create = useMutation({
    mutationFn: () => api.createKey(name, restricted ? allowed : null),
    onSuccess: (r) => {
      setCreated(r.key)
      qc.invalidateQueries({ queryKey: ['keys'] })
    },
    onError: (err) => setError(err instanceof ApiError && err.issues.length ? err.issues.map((i) => i.message).join('；') : errorMessage(err)),
  })

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog size="lg" className="p-6">
        <Dialog.Title className="text-lg font-semibold">{created ? 'Key 已创建' : '创建 API Key'}</Dialog.Title>
        {created ? (
          <div className="mt-4 flex flex-col gap-4">
            <Banner variant="alert" icon={<WarningIcon weight="fill" />} description="Key 只显示这一次，关闭后无法再查看。请现在复制保存。" />
            <ClipboardText text={created} />
            <div className="flex justify-end">
              <Button variant="primary" onClick={onClose}>
                完成
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="mt-4 flex flex-col gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              if (restricted && allowed.length === 0) return setError('至少选择一个渠道组')
              create.mutate()
            }}
          >
            <Input label="名称" placeholder="cf-task 告警" value={name} onChange={(e) => setName(e.target.value)} />
            <Switch label="只允许发送到指定渠道组" checked={restricted} onCheckedChange={setRestricted} />
            {restricted &&
              (channelGroups.data?.length ? (
                <Checkbox.Group legend="可用渠道组" value={allowed} onValueChange={setAllowed}>
                  {channelGroups.data.map((t) => (
                    <Checkbox.Item key={t.id} value={t.slug} label={`${t.name}（${t.slug}）`} />
                  ))}
                </Checkbox.Group>
              ) : (
                <Text variant="secondary">还没有渠道组。</Text>
              ))}
            {error && <Banner variant="error" size="sm" description={error} />}
            <div className="flex justify-end gap-2">
              <Dialog.Close render={(p) => <Button {...p}>取消</Button>} />
              <Button type="submit" variant="primary" loading={create.isPending}>
                创建
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </Dialog.Root>
  )
}
