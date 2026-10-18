# 接入指南

[返回 README](../README.md)

## 渠道、渠道组与 API Key

渠道是具体的投递目标，例如一个飞书机器人或一组邮箱。渠道组为多个渠道设置稳定标识，例如 `ops-alert`；调用方传入该标识，消息发给组内所有已启用渠道。同一请求中的重复渠道只投递一次。

渠道类型和渠道组标识创建后不能修改；渠道组名称及绑定可调整。消息提交时会保存内容与投递目标快照，后续调整绑定或模板不会改变已提交消息的目标和内容。

在后台为每个调用方创建独立 API Key，便于区分来源和单独吊销。限制了渠道组的 Key 只能通过被允许的 `channelGroup` 发送，不能直接指定非空 `channels`；模板展开后的目标同样受此权限限制。

## HTTP API

使用后台生成的 API Key 认证：

```text
Authorization: Bearer cfs_...
```

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/send` | 提交自定义消息或模板消息 |
| GET | `/api/messages/:id` | 查询消息及各渠道投递结果 |
| POST | `/api/messages/:id/cancel` | 取消尚未开始的投递 |

渠道、渠道组、模板与 API Key 在后台管理。部署后的 `/admin/api-docs` 提供完整请求和响应示例，可直接复制使用。

### 自定义消息

发送示例见 [README](../README.md#发送第一条消息)。请求体支持以下字段：

| 字段 | 说明 |
| --- | --- |
| `channelGroup` | 渠道组标识，与 `channels` 至少提供一个目标 |
| `channels` | 渠道 ID 数组，可与渠道组同时提供，目标去重 |
| `title` / `body` | 至少一个非空；标题最多 256 字符，正文按 UTF-8 编码最多 16 KB |
| `format` | `text`（默认）或 `markdown`，由各渠道转换或降级 |
| `level` | `info`（默认）、`warn` 或 `error`，影响渠道标题、卡片颜色等 |
| `url` / `tags` | 可选链接与标签，标签最多 10 个 |
| `sendAt` | 毫秒时间戳或 ISO 8601，最多提前 365 天；省略或已过去时立即安排投递 |
| `raw` | 按渠道类型自定义请求体，例如 `{"feishu":{"msg_type":"text","content":{"text":"通知"}}}` |

`raw` 会替换该渠道生成的请求体，路由字段、凭据和签名仍由已保存的渠道配置控制，不能用它增加其他接收人。Bark 和 Email 会过滤非 ASCII 的顶层字段名，字段值仍支持中文和表情。

本文 KB 按 1,024 字节计算。正文最多 16 KB，`raw` JSON 序列化后最多 32 KB；HTTP JSON 请求体整体最多 256 KB，包含 JSON 转义后的大小。整体超限返回 413，字段内容超限返回 422。

### 查询、取消与幂等

新消息返回 `202 { messageId, deliveries: [...] }`。投递是异步过程，HTTP 请求成功不等于各渠道已经完成投递。

下面的 `SENDER_BASE_URL`、`SENDER_API_KEY` 与 README 示例相同，`MESSAGE_ID` 替换为响应中的 `messageId`：

```sh
curl "$SENDER_BASE_URL/api/messages/MESSAGE_ID" \
  -H "Authorization: Bearer $SENDER_API_KEY"

curl -X POST "$SENDER_BASE_URL/api/messages/MESSAGE_ID/cancel" \
  -H "Authorization: Bearer $SENDER_API_KEY"
```

查询和取消必须使用创建消息的同一个 API Key，其他 Key 或后台创建的消息返回 404。取消只影响 `scheduled`、`queued` 投递，不能撤回发送中或已发送的通知；响应中的 `canceled` 是本次实际取消的条数，重复取消可能为 0。

发送接口支持 `Idempotency-Key` 请求头，去除首尾空格后长度为 1 至 255。每个业务事件使用固定且唯一的键；同一 API Key 和键再次请求时返回 `200`、`duplicate: true` 和原消息，即使正文或模板已改变也不会重新发送。不同 API Key 的幂等空间独立，消息记录清理后该键可再次创建消息。

消息整体状态包括等待调度的 `scheduled`、未完成的 `pending`、全部成功的 `sent`、部分成功的 `partial`、失败的 `failed` 和全部取消的 `canceled`。详情中的 `deliveries` 分别记录每个渠道的状态、尝试次数、上游 HTTP 状态、错误和完成时间。所有响应时间戳均为毫秒。

### 常见错误

| 状态码 | 含义 |
| --- | --- |
| 401 | API Key 缺失、无效或已吊销 |
| 403 | API Key 无权向指定目标发送 |
| 404 | 消息不存在、已清理或不属于当前 Key |
| 408 | 请求体在 10 秒内未读取完成，响应 `error: request_timeout` |
| 413 | HTTP JSON 请求体超过 256 KB，响应含 `maxBytes: 262144` |
| 422 | 参数、目标、模板、变量或内容大小不符合要求，响应 `issues` 包含字段路径和原因 |
| 429 | 费用保护额度已用尽或积压已满，响应 `error: safety_limit`；遵守 `Retry-After` 后沿用原幂等键重试 |
| 503 | 管理员已暂停发送，响应 `error: safety_limit, reason: paused` |
| 500 | 服务内部错误，重试发送时沿用原幂等键 |

这些状态码描述本次 API 请求。上游渠道拒绝、网络错误等投递问题，应查看消息详情中的结果。

## 消息模板

在「模板」页配置文案和默认目标，在「发送消息 › 使用模板」填写变量、预览并发送，也可通过 API 调用。

内置 5 个可编辑模板，初始不绑定接收人：

| 模板 ID | 用途 | 必需变量 |
| --- | --- | --- |
| `new-order` | 新订单通知 | `orderNo` |
| `payment-success` | 支付成功 | `orderNo`、`amount` |
| `order-shipped` | 发货通知 | `orderNo`、`carrier`、`trackingNo` |
| `deployment-result` | 部署结果 | `service`、`environment`、`version`、`result` |
| `service-alert` | 服务告警 | `service`、`message`、`time` |

下面的请求使用 `new-order` 模板，并将默认目标替换为 `ops-alert`：

```sh
curl "$SENDER_BASE_URL/api/send" \
  -H "Authorization: Bearer $SENDER_API_KEY" \
  -H 'Idempotency-Key: order-202610180001' \
  -H 'Content-Type: application/json' \
  -d '{
    "templateId": "new-order",
    "variables": { "orderNo": "202610180001" },
    "channelGroup": "ops-alert"
  }'
```

模板标题和正文使用 `{{variableName}}`。变量名以英文字母开头，只含字母、数字和下划线；值支持字符串、数字、布尔值，不支持嵌套对象或表达式。缺失或空白变量返回 422，`0` 和 `false` 是有效值。模板 ID 创建后固定，`new` 是保留标识。

最多提供 50 个变量，单个字符串最多 16 KB，整个变量对象序列化后最多 32 KB，展开后的正文最多 16 KB。变量只做文本替换，不执行表达式或递归展开。

未传目标时使用模板默认目标。指定 `channels` 或 `channelGroup` 中任一个字段，都会完整替换默认目标，不会额外发送给原接收人。模板请求可附带 `sendAt`，不能同时传入 `title`、`body`、`format`、`level`、`url`、`tags` 或 `raw`，格式和级别由模板设置。

消息提交后保存渲染内容和目标，后续修改或删除模板不会改变已提交的消息、重试或相同幂等键对应的消息。

## Worker Service Binding

同一 Cloudflare 账号下的 Worker 可以直接调用 RPC，无需 API Key。在调用方的 `wrangler.jsonc` 中合并以下配置，将 `service` 替换为实际的 Sender Worker 名称：

```json
{
  "services": [
    { "binding": "SENDER", "service": "yunji-sender", "entrypoint": "SenderRpc" }
  ]
}
```

在调用方代码中发送消息：

```ts
const result = await env.SENDER.send(
  { channelGroup: 'ops-alert', title: '任务失败', body: '数据同步失败', level: 'error' },
  { idempotencyKey: 'sync-job-202610180001' },
)
```

`send()` 同样支持 `templateId`、`variables` 和 `sendAt`。RPC 调用不受 HTTP API Key 的渠道组权限限制，只应向可信调用方提供绑定。

## 渠道配置

在「渠道」页选择类型后，后台会显示对应凭据与可选设置。凭据字段加密保存，接口不返回已保存的明文；编辑时留空保留原值。各渠道支持「测试」，可先单独确认目标可用，再绑定渠道组。

已保存的可选凭据（如签名密钥、Webhook 请求头、PushPlus 指定接收人）可点击「清除已保存的值」，保存后生效，保存前可以撤销。必填凭据不可清除。后台接口 `PUT /admin/api/channels/:id` 使用 `clearSecrets: ["字段名"]` 显式清除可选凭据；`config` 中省略、空字符串或 `null` 仍表示保留旧值。同一字段不能同时提交非空新值和清除请求。

Markdown 的呈现取决于渠道：Telegram 转为 HTML，Slack 转为 mrkdwn，Email 转为 HTML 邮件，Bark 降为纯文本；飞书以卡片发送 Markdown。渠道有自己的正文长度和格式限制，部分适配器会截断过长内容。Webhook 只发送规范化 JSON，不代替接收端渲染。

### PushPlus

填入用户 Token 或消息 Token，默认推送到自己的微信公众号。可选填 PushPlus 群组编码、接收渠道、渠道配置编码和指定接收人；这里的群组编码属于 PushPlus，与云吉 Sender 的渠道组独立。短信和语音会使用 PushPlus 的付费服务，Token 和指定接收人加密保存。

PushPlus 成功只表示平台已受理，本项目尚未接入最终送达回调。账号受限、凭据错误等业务失败会记录原因；网络错误、HTTP 429/5xx 和 PushPlus 系统异常会重试，业务码 900 表示账号受限，不再自动重试。

### Server 酱

填入 SendKey，自动识别 Turbo 的 `SCT...` 和 Server 酱³ 的 `sctp{uid}t...`。接收通道在 Server 酱平台配置，SendKey 加密保存。正文支持 Markdown，缺少标题时从正文生成，标题整理为单行并截断至 32 个 UTF-16 单元。
