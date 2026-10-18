import { tr, useLocale } from '../i18n'
import { Badge, Button, CodeBlock, Link, Text, useKumoToastManager } from '@cloudflare/kumo'
import { CopyIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import type { MessageDetail, SendRequest, SendResult } from '../../../src/shared/types'
import { PageHeader } from '../components/PageHeader'

const SECTIONS = [
  ['quickstart', '快速开始'],
  ['send', '发送消息'],
  ['templates', '使用模板'],
  ['query', '查询结果'],
  ['cancel', '取消投递'],
  ['conventions', '调用约定'],
  ['errors', '错误码'],
] as const

const DIRECT_REQUEST = {
  channelGroup: 'ops-alert',
  title: '你有一个新订单',
  body: '订单号：202610170001',
} satisfies SendRequest

const TEMPLATE_REQUEST = {
  templateId: 'new-order',
  variables: { orderNo: '202610170001' },
} satisfies SendRequest

const EXAMPLE_AT = Date.UTC(2026, 9, 17, 8, 30)
const SEND_RESPONSE = {
  messageId: '0414d02c-b713-4ef6-bef1-39cf6a919b70',
  duplicate: false,
  sendAt: EXAMPLE_AT,
  deliveries: [{
    id: '4a121c60-9d47-4828-ae74-1f4dd33bb6e8',
    channelId: '6d5d4f35-8155-4b30-8dca-4b97d6a2b185',
    channelName: '订单通知',
    channelType: 'webhook',
    status: 'queued',
  }],
} satisfies SendResult

const MESSAGE_RESPONSE = {
  id: SEND_RESPONSE.messageId,
  channelGroupSlug: 'ops-alert',
  source: 'api',
  apiKeyId: 'example-api-key-id',
  title: DIRECT_REQUEST.title,
  level: 'info',
  status: 'sent',
  counts: { total: 1, sent: 1, failed: 0, canceled: 0, pending: 0, scheduled: 0 },
  sendAt: EXAMPLE_AT,
  createdAt: EXAMPLE_AT,
  content: { title: DIRECT_REQUEST.title, body: DIRECT_REQUEST.body, format: 'text', level: 'info', url: null, tags: [], raw: {} },
  deliveries: [{
    ...SEND_RESPONSE.deliveries[0],
    messageId: SEND_RESPONSE.messageId,
    status: 'sent',
    attempts: 1,
    nextAttemptAt: EXAMPLE_AT,
    durationMs: 183,
    httpStatus: 200,
    responseBody: 'ok',
    error: null,
    finishedAt: EXAMPLE_AT + 183,
    createdAt: EXAMPLE_AT,
    updatedAt: EXAMPLE_AT + 183,
  }],
} satisfies MessageDetail

interface Field {
  name: string
  type: string
  description: ReactNode
}

const SEND_FIELDS: Field[] = [
  { name: 'channelGroup', type: 'string · 按目标选填', description: '渠道组的标识（slug），最长 64。发送给该组所有已启用渠道，使用标识而不是名称或 ID。' },
  { name: 'channels', type: 'string[] · 按目标选填', description: '渠道 ID 数组，最多 50 项。与 channelGroup 至少提供一个；同时提供时合并目标，重复渠道只投递一次。显式指定不存在或已停用的渠道会返回 422。' },
  { name: 'title', type: 'string · 默认空字符串', description: '标题，最长 256。与 body 至少一个非空。' },
  { name: 'body', type: 'string · 默认空字符串', description: '正文，按 UTF-8 编码最多 16 KB（16,384 字节）。各渠道根据自身限制转换或截断内容。' },
  { name: 'format', type: '"text" | "markdown"', description: '默认 text。Markdown 会按渠道能力转换或降级。' },
  { name: 'level', type: '"info" | "warn" | "error"', description: '默认 info。影响标题前缀、卡片颜色等展示。' },
  { name: 'url', type: 'string | null · 可选', description: 'http:// 或 https:// 链接，最长 2,048。空字符串按 null 处理。' },
  { name: 'tags', type: 'string[] · 默认 []', description: '最多 10 个标签，每项去除首尾空格后长度为 1–32。' },
  { name: 'sendAt', type: 'number | string · 可选', description: '正整数毫秒时间戳或可解析的 ISO 8601 时间。建议明确带上时区，例如 2026-10-18T09:00:00+08:00。最多提前 365 天，省略或已过去按立即发送处理。' },
  { name: 'raw', type: 'object · 默认 {}', description: '按渠道类型覆盖生成的请求体，例如 {"feishu":{"msg_type":"text","content":{"text":"订单已创建"}}}。目标、签名和收件人仍由渠道配置补充。JSON 序列化后按 UTF-8 编码最多 32 KB；Bark 和 Email 会过滤非 ASCII 顶层字段名。' },
]

function FieldList({ fields }: { fields: Field[] }) {
  useLocale()
  return (
    <dl className="divide-y divide-kumo-hairline text-sm">
      {fields.map((field) => (
        <div key={field.name} className="grid gap-1 py-3 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
          <dt className="min-w-0">
            <code className="break-all font-medium text-kumo-default">{field.name}</code>
            <div className="mt-1 break-words text-xs text-kumo-subtle">{tr(field.type)}</div>
          </dt>
          <dd className="min-w-0 break-words leading-7 text-kumo-default">{typeof field.description === 'string' ? tr(field.description) : field.description}</dd>
        </div>
      ))}
    </dl>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  useLocale()
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-6 border-t border-kumo-hairline pt-6 first:border-0 first:pt-0">
      <h2 id={`${id}-heading`} className="mb-4 text-lg font-semibold">{title}</h2>
      <div className="flex min-w-0 flex-col gap-4 text-sm leading-7">{children}</div>
    </section>
  )
}

function Example({ title, code, lang = 'bash' }: { title: string; code: string; lang?: 'bash' | 'jsonc' }) {
  useLocale()
  const toasts = useKumoToastManager()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      toasts.add({ title: tr('示例已复制'), variant: 'success' })
    } catch {
      toasts.add({ title: tr('复制失败，请手动选择代码复制'), variant: 'error' })
    }
  }
  return (
    <figure className="min-w-0 [&_pre]:overflow-x-auto">
      <figcaption className="mb-2 flex items-center justify-between gap-3">
        <Text size="sm" bold>{title}</Text>
        <Button size="sm" variant="ghost" icon={CopyIcon} aria-label={tr('复制{%value0%}', { value0: title })} onClick={copy}>{tr('复制')}</Button>
      </figcaption>
      <CodeBlock code={code} lang={lang} />
    </figure>
  )
}

function Endpoint({ method, path }: { method: 'POST' | 'GET'; path: string }) {
  return <div className="flex flex-wrap items-center gap-2"><Badge variant="secondary">{method}</Badge><code className="break-all font-medium">{path}</code></div>
}

export default function ApiDocsPage() {
  useLocale()
  const origin = window.location.origin
  // Only authored documentation examples are localized; API responses and saved data stay intact.
  const exampleContent = { title: tr(DIRECT_REQUEST.title), body: tr(DIRECT_REQUEST.body) }
  const directRequest = { ...DIRECT_REQUEST, ...exampleContent }
  const sendResponse = { ...SEND_RESPONSE, deliveries: SEND_RESPONSE.deliveries.map((d) => ({ ...d, channelName: tr(d.channelName) })) }
  const messageResponse = {
    ...MESSAGE_RESPONSE, title: exampleContent.title,
    content: { ...MESSAGE_RESPONSE.content, ...exampleContent },
    deliveries: MESSAGE_RESPONSE.deliveries.map((d) => ({ ...d, channelName: tr(d.channelName) })),
  }
  const sendCurl = (body: SendRequest) => `curl -X POST "${origin}/api/send" \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body, null, 2)}'`

  return (
    <>
      <PageHeader title={tr('API 文档')} description={tr('通过 HTTP API 发送通知，并查询每个渠道的投递结果。')} />
      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_9rem]">
        <nav aria-label={tr('API 文档目录')} className="flex flex-wrap gap-x-4 gap-y-2 text-sm xl:sticky xl:top-6 xl:col-start-2 xl:row-start-1 xl:flex-col xl:gap-3">
          {SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`} className="text-kumo-subtle underline-offset-4 hover:text-kumo-default hover:underline focus-visible:underline">{tr(label)}</a>)}
        </nav>
        <div className="flex min-w-0 flex-col gap-8 xl:col-start-1 xl:row-start-1">
          <Section id="quickstart" title={tr('快速开始')}>
            <p>{tr('先在')}<Link href="/channels">{tr('渠道')}</Link>{tr('中配置接收目标，再在')}<Link href="/keys">API Key</Link>{tr('页创建密钥。请求通过')}<code>Authorization: Bearer YOUR_API_KEY</code>{tr('认证，后台登录密码不能代替 API Key。')}</p>
            <div className="rounded-md bg-kumo-base px-3 py-2 font-mono text-kumo-subtle break-all">{origin}/api</div>
            <p>{tr('下面向一个渠道组发送订单通知。把')}<code>YOUR_API_KEY</code>{tr('换成实际密钥，把')}<code>ops-alert</code>{tr('换成')}<Link href="/channel-groups">{tr('渠道组')}</Link>{tr('中绑定了已启用渠道的标识。也可以使用渠道 ID 数组')}<code>channels</code>{tr('。')}</p>
            <Example title={tr('发送第一条消息')} code={sendCurl(directRequest)} />
            <p><strong>{tr('返回 202 表示已受理。')}</strong>{tr('请保存响应中的')}<code>messageId</code>{tr('，再查询投递结果。队列和直接发送都使用相同的接口。')}</p>
          </Section>

          <Section id="send" title={tr('发送消息')}>
            <Endpoint method="POST" path="/api/send" />
            <p>{tr('请求体为 JSON，')}<code>Content-Type: application/json</code>{tr('。自定义消息支持以下字段；使用模板时请参考下一节。')}</p>
            <FieldList fields={SEND_FIELDS} />
            <p className="text-kumo-subtle">{tr('标题等字符数量限制按 UTF-16 单元计算；正文、raw 和模板变量的 KB 限制按 UTF-8 字节计算，1 KB = 1,024 字节。单个 JSON 请求最多 256 KB，超出返回 413；未知字段返回 422。')}</p>
            <Example title={tr('受理响应示例（202）')} lang="jsonc" code={JSON.stringify(sendResponse, null, 2)} />
            <p><code>sendAt</code>{tr('为实际采用的毫秒时间戳；')}<code>deliveries</code>{tr('为每个目标渠道的投递记录。响应时的状态可能为')}<code>scheduled</code>{tr('、')}<code>queued</code>{tr('，也可能已进入后续阶段，应通过查询接口确认。')}</p>
          </Section>

          <Section id="templates" title={tr('使用模板')}>
            <p>{tr('仍然调用')}<code>POST /api/send</code>{tr('。先到')}<Link href="/templates">{tr('模板')}</Link>{tr('页设置文案和默认渠道或渠道组，然后只传模板 ID 和变量。')}</p>
            <Example title={tr('通过模板发送订单通知')} code={sendCurl(TEMPLATE_REQUEST)} />
            <FieldList fields={[
              { name: 'templateId', type: tr('string · 必填'), description: tr('后台模板的 ID，例如内置的新订单模板 new-order。模板可以编辑或删除，以后台当前配置为准。') },
              { name: 'variables', type: tr('object · 默认 {}'), description: tr('变量名以英文字母开头，只含字母、数字和下划线，最长 64。值支持字符串、有限数字和布尔值，不支持数组、对象或 null。模板中引用的变量必须齐全，空白字符串视为缺失，0 和 false 是有效值。最多 50 项，单个字符串按 UTF-8 编码最多 16 KB，整个对象 JSON 序列化后最多 32 KB。渲染后的正文最多 16 KB。') },
              { name: 'channelGroup / channels', type: tr('同发送消息 · 可选'), description: tr('不传时使用模板默认目标。传入任意一个字段都会完整替换默认目标，不会额外发给原来的接收人。内置模板初始未配置目标，需要先配置或在请求中指定。') },
              { name: 'sendAt', type: tr('number | string · 可选'), description: tr('支持与自定义消息相同的定时参数。') },
            ]} />
            <p>{tr('模板调用只接受以上字段，不能同时传入')}<code>title</code>{tr('、')}<code>body</code>{tr('、')}<code>format</code>{tr('、')}<code>level</code>{tr('、')}<code>url</code>{tr('、')}<code>tags</code>{tr('或')}<code>raw</code>{tr('。格式和级别使用模板设置；渲染后的标题和正文仍受长度限制。变量只做文本替换，不执行表达式或递归展开。')}</p>
            <Example title={tr('覆盖模板默认目标')} lang="jsonc" code={JSON.stringify({ ...TEMPLATE_REQUEST, channels: ['CHANNEL_ID'] } satisfies SendRequest, null, 2)} />
            <p className="text-kumo-subtle">{tr('请替换示例中的 CHANNEL_ID。模板在提交时展开并保存内容和目标；后续编辑或删除模板不会改变已提交的消息。')}</p>
          </Section>

          <Section id="query" title={tr('查询结果')}>
            <Endpoint method="GET" path="/api/messages/:id" />
            <p>{tr('把')}<code>MESSAGE_ID</code>{tr('换成发送响应中的')}<code>messageId</code>{tr('。必须使用创建该消息的同一个 API Key；其他 Key 或后台创建的消息均返回 404。')}</p>
            <Example title={tr('查询消息')} code={`curl "${origin}/api/messages/MESSAGE_ID" \\\n  -H "Authorization: Bearer YOUR_API_KEY"`} />
            <p>{tr('成功返回')}<code>200 {`{ "message": { ... } }`}</code>{tr('。')}<code>message.content</code>{tr('是实际保存的内容，')}<code>message.deliveries</code>{tr('包含各渠道的尝试次数、上游 HTTP 状态、错误和完成时间。所有响应时间戳均为毫秒。')}</p>
            <FieldList fields={[
              { name: 'scheduled', type: 'message.status', description: tr('投递均在等待调度，发送时间尚未到。') },
              { name: 'pending', type: 'message.status', description: tr('仍有投递尚未完成，可能排队、发送中或等待重试。') },
              { name: 'sent', type: 'message.status', description: tr('全部渠道投递成功。代表对应渠道服务已受理，实际终端送达以渠道为准。') },
              { name: 'partial', type: 'message.status', description: tr('所有投递已结束，其中部分成功，其余失败或取消。') },
              { name: 'failed', type: 'message.status', description: tr('所有投递已结束，没有成功，至少一条失败。') },
              { name: 'canceled', type: 'message.status', description: tr('全部投递均已取消。') },
            ]} />
            <p>{tr('单条投递的')}<code>deliveries[].status</code>{tr('为')}<code>scheduled / queued / sending / sent / failed / canceled</code>{tr('。')}<code>counts</code>{tr('包含 total、sent、failed、canceled、pending、scheduled；pending 包含 scheduled、queued 和 sending。')}</p>
            <details className="min-w-0">
              <summary className="cursor-pointer font-medium underline-offset-4 hover:underline">{tr('查看完整查询响应示例（200）')}</summary>
              <div className="mt-3 min-w-0"><Example title={tr('消息详情响应')} lang="jsonc" code={JSON.stringify({ message: messageResponse }, null, 2)} /></div>
            </details>
          </Section>

          <Section id="cancel" title={tr('取消投递')}>
            <Endpoint method="POST" path="/api/messages/:id/cancel" />
            <Example title={tr('取消尚未开始的投递')} code={`curl -X POST "${origin}/api/messages/MESSAGE_ID/cancel" \\\n  -H "Authorization: Bearer YOUR_API_KEY"`} />
            <Example title={tr('取消响应示例（200）')} lang="jsonc" code={'{ "canceled": 1 }'} />
            <p><code>canceled</code>{tr('是本次实际取消的投递条数，只取消')}<code>scheduled</code>{tr('和')}<code>queued</code>{tr('。已发送、发送中或已失败的投递不会撤回。重复取消可能返回')}<code>{`{ "canceled": 0 }`}</code>{tr('，属于正常结果。消息归属规则与查询相同。')}</p>
          </Section>

          <Section id="conventions" title={tr('调用约定')}>
            <FieldList fields={[
              { name: 'Idempotency-Key', type: tr('请求头 · 仅发送接口'), description: tr('可选，去除首尾空格后长度 1–255。推荐每个业务事件使用固定且唯一的键，例如 order-202610170001。相同 API Key 和幂等键再次请求时返回 200、duplicate: true 和原消息，不会重新发送；即使请求内容或模板已改变，也返回原消息。不同 API Key 的幂等空间独立。') },
              { name: tr('权限'), type: 'API Key', description: tr('限制到渠道组的 Key 只能通过被允许的 channelGroup 发送，不能直接指定非空 channels。模板的最终目标同样受此限制。不限制渠道组的 Key 可以选择任意已启用渠道。') },
              { name: tr('定时与重试'), type: tr('异步投递'), description: tr('sendAt 不是精确送达承诺。队列模式下，本项目将 12 小时内的任务交给队列延迟执行；更远的任务由 Cron 派发。直接发送模式下，定时和重试由每分钟 Cron 处理。可重试错误自动退避，最多尝试次数由后台设置控制。') },
              { name: tr('保留与幂等'), type: tr('消息记录'), description: tr('已结束的消息按后台保留天数清理。记录清理后查询返回 404，对应幂等键也不再阻止创建新消息。') },
            ]} />
            <Example title={tr('带幂等键的请求')} code={sendCurl(directRequest).replace('  -H "Content-Type:', '  -H "Idempotency-Key: order-202610170001" \\\n  -H "Content-Type:')} />
            <p className="text-kumo-subtle">{tr('上面三个是对外 HTTP 接口。渠道、渠道组、模板和密钥在后台管理。另有同账号 Worker 的 Service Binding 调用示例，见')}<Link href="/settings">{tr('设置')}</Link>{tr('页。')}</p>
          </Section>

          <Section id="errors" title={tr('错误码')}>
            <FieldList fields={[
              { name: '401', type: 'unauthorized', description: tr('缺少 Bearer Token，或 API Key 无效、已吊销、已删除。') },
              { name: '403', type: 'forbidden', description: tr('API Key 无权向指定目标发送。响应包含 message 说明原因。') },
              { name: '404', type: 'not_found', description: tr('消息不存在、已清理，或不属于当前 API Key；公开 API 路径不存在也返回此错误。') },
              { name: '408', type: 'request_timeout', description: tr('请求体未在 10 秒内读取完成。请检查网络并沿用同一个 Idempotency-Key 重试。') },
              { name: '413', type: 'payload_too_large', description: tr('JSON 请求体超过 256 KB，响应 maxBytes 表示允许的最大字节数。') },
              { name: '422', type: 'validation_failed', description: tr('JSON 不合法、参数错误、模板或目标不存在、渠道停用、变量缺失或内容超限。响应 issues 数组包含字段路径 path 和说明 message。') },
              { name: '429 / 503', type: 'safety_limit', description: tr('429 表示费用保护额度耗尽或积压已满，503 表示管理员已暂停发送。遵守 Retry-After，并沿用同一个 Idempotency-Key 重试。') },
              { name: '500', type: 'internal_error', description: tr('服务内部异常。发送请求重试时沿用同一个 Idempotency-Key，避免重复创建消息。') },
            ]} />
            <Example title={tr('模板变量缺失示例（422）')} lang="jsonc" code={JSON.stringify({ error: 'validation_failed', issues: [{ path: 'variables.orderNo', message: tr('缺少变量：orderNo') }] }, null, 2)} />
            <p>{tr('这些状态码描述本次 API 请求。投递时的网络错误、上游 HTTP 错误和业务拒绝，请在消息详情的')}<code>deliveries</code>{tr('中查看。')}</p>
          </Section>
        </div>
      </div>
    </>
  )
}
