import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { processDelivery } from '../src/delivery/process'
import { deleteChannel, updateChannel } from '../src/domain/channels'
import { getMessage } from '../src/domain/messages'
import { deleteTemplate, getTemplate, listTemplates, saveTemplate } from '../src/domain/templates'
import { SenderRpc } from '../src/rpc'
import { renderTemplate } from '../src/shared/templates'
import { adminCall, apiCall, apiKey, envWithQueue, mockFetch, request, channelGroupWith, webhookChannel } from './helpers'

afterEach(() => vi.restoreAllMocks())
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })

async function fixture(overrides: Record<string, unknown> = {}) {
  const channel = await webhookChannel()
  const template = (await saveTemplate(env.DB, {
    id: 'order-test', name: '订单测试', title: '新订单 {{orderNo}}', body: '金额：{{amount}} 元',
    channels: [channel.id], ...overrides,
  }))!
  return { channel, template }
}

describe('template management', () => {
  it('seeds five usable defaults with discoverable variables and no implicit recipients', async () => {
    const templates = await listTemplates(env.DB)
    expect(templates.map((t) => t.id)).toEqual(['deployment-result', 'new-order', 'order-shipped', 'payment-success', 'service-alert'])
    const channel = await webhookChannel()
    const q = envWithQueue()
    for (const template of templates) {
      expect(template.channels).toEqual([])
      expect(template.channelGroup).toBeNull()
      expect(template.variables.length).toBeGreaterThan(0)
      const variables = Object.fromEntries(template.variables.map((key) => [key, `example-${key}`]))
      const response = await adminCall('/send', post({ templateId: template.id, variables, channels: [channel.id] }), q.env)
      expect(response.status).toBe(202)
      const result = await response.json() as any
      const message = await getMessage(env.DB, result.messageId)
      expect(message!.content.body).not.toContain('{{')
      expect(message!.content.level).toBe(template.level)
    }
    expect(q.sent).toHaveLength(5)
  })

  it('protects management behind admin auth and supports create, read, update, delete', async () => {
    expect((await request('/admin/api/templates')).status).toBe(401)
    const res = await adminCall('/templates', post({ id: 'custom', name: '自定义', body: '你好 {{name}}' }))
    expect(res.status).toBe(201)
    const { template } = await res.json() as any
    expect(template).toMatchObject({ id: 'custom', variables: ['name'], channels: [], channelGroup: null })
    expect((await adminCall('/templates/custom')).status).toBe(200)
    const update = await adminCall('/templates/custom', { ...post({ ...template, body: '您好 {{name}}，订单 {{orderNo}}' }), method: 'PUT' })
    expect(update.status).toBe(200)
    expect((await update.json() as any).template.variables).toEqual(['name', 'orderNo'])
    expect((await adminCall('/templates/custom', { method: 'DELETE' })).status).toBe(204)
    expect((await adminCall('/templates/custom')).status).toBe(404)
    expect((await adminCall('/templates/custom', { method: 'DELETE' })).status).toBe(404)
    expect((await adminCall('/templates/custom', { ...post(template), method: 'PUT' })).status).toBe(404)
  })

  it('rejects duplicate ids, id changes, unknown targets and invalid placeholders', async () => {
    const { template } = await fixture()
    expect((await adminCall('/templates', post(template))).status).toBe(422)
    expect((await adminCall(`/templates/${template.id}`, { ...post({ ...template, id: 'changed' }), method: 'PUT' })).status).toBe(422)
    for (const patch of [{ channels: ['missing'] }, { channelGroup: 'missing' }, { body: '{{user.name}}' }, { title: '{{{name}}}' }, { title: '', body: '' }, { id: 'new' }]) {
      const response = await adminCall('/templates', post({ ...template, id: 'new-one', ...patch }))
      expect(response.status).toBe(422)
    }
  })

  it('deduplicates channel targets and variable names', async () => {
    const { channel } = await fixture()
    const template = await saveTemplate(env.DB, { id: 'dedup', name: '去重', title: '{{name}}', body: '{{ name }} {{other}} {{name}}', channels: [channel.id, channel.id] })
    expect(template).toMatchObject({ channels: [channel.id], variables: ['name', 'other'] })
  })
})

describe('template sending', () => {
  it('accepts just an id and variables, fans out, and snapshots the rendered content', async () => {
    const { template } = await fixture()
    const second = await webhookChannel('second')
    await saveTemplate(env.DB, { ...template, channels: [...template.channels, second.id] }, template.id)
    const q = envWithQueue()
    const key = await apiKey()
    const response = await apiCall(key, '/send', post({ templateId: template.id, variables: { orderNo: 'NO-1', amount: 99 } }), q.env)
    expect(response.status).toBe(202)
    const result = await response.json() as any
    expect(result.deliveries).toHaveLength(2)
    expect(q.sent).toHaveLength(2)
    expect((await getMessage(env.DB, result.messageId))!.content).toMatchObject({ title: '新订单 NO-1', body: '金额：99 元', format: 'text' })
    await saveTemplate(env.DB, { ...template, body: '新版通知' }, template.id)
    await deleteTemplate(env.DB, template.id)
    const calls = mockFetch(() => new Response('ok'))
    await processDelivery(q.env, { deliveryId: result.deliveries[0].id, attempt: 0 })
    expect(calls[0].json()).toMatchObject({ title: '新订单 NO-1', body: '金额：99 元' })
  })

  it('preserves the snapshot through retry after the template has been deleted', async () => {
    const { template } = await fixture()
    const q = envWithQueue()
    const response = await adminCall('/send', post({ templateId: template.id, variables: { orderNo: 'R', amount: 0 } }), q.env)
    const result = await response.json() as any
    const calls = mockFetch(() => new Response('unavailable', { status: 503 }))
    await processDelivery(q.env, { deliveryId: result.deliveries[0].id, attempt: 0 })
    await deleteTemplate(env.DB, template.id)
    await processDelivery(q.env, { deliveryId: result.deliveries[0].id, attempt: 1 })
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.json().body)).toEqual(['金额：0 元', '金额：0 元'])
  })

  it('uses saved channelGroups but enforces restricted API key permissions on the effective targets', async () => {
    const { channel, template } = await fixture()
    await channelGroupWith('orders', [channel.id])
    await channelGroupWith('other', [channel.id])
    const saved = (await saveTemplate(env.DB, { ...template, channels: [], channelGroup: 'orders' }, template.id))!
    const q = envWithQueue()
    const key = await apiKey(['orders'])
    const body = { templateId: saved.id, variables: { orderNo: 'A', amount: 1 } }
    expect((await apiCall(key, '/send', post(body), q.env)).status).toBe(202)
    expect((await apiCall(key, '/send', post({ ...body, channelGroup: 'other' }), q.env)).status).toBe(403)
    expect((await apiCall(key, '/send', post({ ...body, channels: [channel.id] }), q.env)).status).toBe(403)
    await saveTemplate(env.DB, { ...saved, channels: [channel.id] }, saved.id)
    expect((await apiCall(key, '/send', post(body), q.env)).status).toBe(403)
    expect(q.sent).toHaveLength(1)
  })

  it('replaces the whole saved routing when explicit channels or channelGroup are supplied', async () => {
    const { channel, template } = await fixture()
    await channelGroupWith('orders', [channel.id])
    await saveTemplate(env.DB, { ...template, channelGroup: 'orders' }, template.id)
    const other = await webhookChannel('other')
    const q = envWithQueue()
    const response = await adminCall('/send', post({ templateId: template.id, variables: { orderNo: 'A', amount: 1 }, channels: [other.id] }), q.env)
    const result = await response.json() as any
    expect(result.deliveries.map((d: any) => d.channelId)).toEqual([other.id])
    expect((await getMessage(env.DB, result.messageId))!.channelGroupSlug).toBeNull()
  })

  it('rejects empty, removed and disabled targets without creating a message', async () => {
    const q = envWithQueue()
    const variables = { orderNo: 'A', amount: 1 }
    expect((await adminCall('/send', post({ templateId: 'new-order', variables }), q.env)).status).toBe(422)
    const { channel, template } = await fixture()
    await updateChannel(env, channel.id, { name: channel.name, type: channel.type, enabled: false, config: {} })
    expect((await adminCall('/send', post({ templateId: template.id, variables }), q.env)).status).toBe(422)
    await deleteChannel(env, channel.id)
    expect((await adminCall('/send', post({ templateId: template.id, variables }), q.env)).status).toBe(422)
    expect(q.sent).toEqual([])
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first()).toEqual({ n: 0 })
  })

  it.each([
    [{ templateId: 'missing' }, 'templateId'],
    [{ templateId: 'order-test', variables: { amount: 1 } }, 'variables.orderNo'],
    [{ templateId: 'order-test', variables: { orderNo: ' ', amount: 1 } }, 'variables.orderNo'],
    [{ templateId: 'order-test', variables: { orderNo: 'A', amount: null } }, 'variables.amount'],
    [{ templateId: 'order-test', variables: { orderNo: 'A', amount: {} } }, 'variables.amount'],
    [{ templateId: 'order-test', variables: [] }, 'variables'],
    [{ variables: { orderNo: 'A' } }, 'templateId'],
  ])('rejects invalid or missing variables: %j', async (body, path) => {
    await fixture()
    const q = envWithQueue()
    const response = await adminCall('/send', post(body), q.env)
    expect(response.status).toBe(422)
    expect((await response.json() as any).issues).toEqual(expect.arrayContaining([expect.objectContaining({ path })]))
    expect(q.sent).toEqual([])
  })

  it('rejects mixed template and raw content inputs', async () => {
    const { template } = await fixture()
    const q = envWithQueue()
    const response = await adminCall('/send', post({ templateId: template.id, variables: { orderNo: 'A', amount: 1 }, body: 'override' }), q.env)
    expect(response.status).toBe(422)
    expect(q.sent).toEqual([])
  })

  it('bounds expanded content before allocation and revalidates the rendered title', async () => {
    const { template } = await fixture({ title: '{{orderNo}}', body: '{{amount}}'.repeat(1000) })
    const q = envWithQueue()
    for (const variables of [{ orderNo: 'A', amount: 'x'.repeat(1000) }, { orderNo: 'x'.repeat(257), amount: 1 }]) {
      expect((await adminCall('/send', post({ templateId: template.id, variables }), q.env)).status).toBe(422)
    }
    expect(q.sent).toEqual([])
  })

  it('renders scalar values literally in a single pass and ignores inherited properties', () => {
    expect(renderTemplate({ title: '{{a}}', body: '{{b}} {{c}}' }, { a: '{{b}}', b: false, c: 0 })).toEqual({ title: '{{b}}', body: 'false 0', missing: [] })
    expect(renderTemplate({ title: '{{constructor}}', body: '' }, {}).missing).toEqual(['constructor'])
  })

  it('supports RPC, scheduling and idempotent sends with template parameters', async () => {
    const { template } = await fixture()
    const q = envWithQueue()
    const ctx = createExecutionContext()
    const rpc = new SenderRpc(ctx, q.env)
    const input = { templateId: template.id, variables: { orderNo: 'RPC', amount: 5 }, sendAt: Date.now() + 60_000 }
    const first = await rpc.send(input, { idempotencyKey: 'order-rpc' })
    await deleteTemplate(env.DB, template.id)
    const again = await rpc.send(input, { idempotencyKey: 'order-rpc' })
    await waitOnExecutionContext(ctx)
    expect(again).toMatchObject({ messageId: first.messageId, duplicate: true })
    expect(q.sent).toHaveLength(1)
    expect(q.sent[0].delaySeconds).toBeGreaterThan(55)
    expect((await getMessage(env.DB, first.messageId))!.content.title).toBe('新订单 RPC')
    expect(await getTemplate(env.DB, template.id)).toBeNull()
  })
})
