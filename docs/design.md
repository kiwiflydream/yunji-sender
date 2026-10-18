# 云吉 Sender（Yunji Sender）设计

## 模型

- **渠道 channel**：一个投递目标（某个飞书群机器人、某个 Telegram 会话、某组邮箱）。字段由 `src/shared/catalog.ts` 描述，后台表单和服务端校验都从这里生成。标记为 `secret` 的字段整体 AES-GCM 加密存入 `secrets_encrypted`（AAD 绑定渠道 id），接口永不返回，编辑时留空表示保留原值。渠道类型创建后不能修改。
- **渠道组 channelGroup**：渠道的命名分组。调用方只写 `channelGroup`，改接收人只改绑定。标识创建后不可修改，名称和绑定可编辑，避免破坏模板及 API Key 的引用。
- **API Key**：`cfs_` 前缀，只存 SHA-256；可限定只能发送到某些渠道组（此时不能直接指定渠道）。`last_used_at` 每分钟最多写一次。
- **消息 message**：一次发送请求，存规范化内容和 `send_at`。
- **投递 delivery**：消息 × 渠道，独立状态、重试和结果。渠道名和渠道组是快照，渠道删除后日志仍可读。

## 消息模板

- `message_templates` 保存稳定的模板 ID、名称、说明、标题/正文、格式、级别和默认发送目标。迁移 `0003_message_templates.sql` 预置新订单、支付成功、发货、部署和服务告警五个模板；默认不绑定接收人，后台可直接编辑。模板 CRUD 仅开放在受认证保护的 `/admin/api/templates`。
- API、后台和 RPC 共用 `sendMessage`：先展开 `templateId + variables`，再执行既有内容长度、目标和 API Key 权限校验。显式传入 `channelGroup` 或 `channels` 时完整替换默认目标。模板调用与手动内容字段互斥。
- 渲染器位于 `src/shared/templates.ts`，后台预览与服务端共用。仅支持平面变量和单次文本替换，不执行表达式，不递归解析变量值；只读取自有属性。缺失和空白变量明确报错，数字 0 与布尔值 false 合法。
- 变量最多 50 个、总长度最多 32 KB；渲染前先计算展开长度，限制最终标题 256 字符、正文 16 KB，避免重复变量造成不受控的字符串分配。模板最多使用 50 个不同变量。
- 渲染结果继续存入 `messages.payload`，投递沿用原快照，不依赖模板存活。幂等请求先按调用方查已接受的消息，防止模板修改、删除后重复请求失败或重复发送。
- 后台沿用现有 Kumo 页面、表格和表单样式；模板列表展示 ID、变量和默认目标，编辑页提供内容/路由配置及变量预览。预览按文本展示，实际渠道格式由原适配器处理。

## 投递状态机

```
scheduled ──cron──▶ queued ──claim──▶ sending ──▶ sent
    ▲                  ▲                 │
    │                  └── retry(queue) ─┤
    └──── retry(direct) / 恢复 ──────────┤
                                         └──▶ failed
scheduled / queued ──cancel──▶ canceled
failed / canceled ──手动重试──▶ queued
```

- `attempts` 是已开始的尝试数。认领是 `UPDATE ... WHERE attempts = ? AND status IN ('scheduled','queued')`，队列消息带着期望的 `attempts`，所以重复消息、恢复出来的投递、手动重试都不会让同一次尝试执行两遍。
- 结果写回同样比较 `status = 'sending' AND attempts = ?`；被租约回收后迟到的结果直接丢弃。
- 统计在关闭投递的同一个 batch 里、先于 UPDATE 写入，条件同上，所以每个最终结果只计一次。手动重试一个已失败的投递时，会先把那次失败从统计里扣掉。

## 执行方式

Cloudflare Queues 同时支持 Workers Free 和 Paid。Free 包含每天 10,000 次操作，消息保留 24 小时；以 [官方计费说明](https://developers.cloudflare.com/queues/platform/pricing/) 为准。执行模式只按 Queue 是否绑定和后台选择决定，不按付费套餐限制。

运行设置 `executionMode`，保存即生效：

| | queue（默认） | direct |
| --- | --- | --- |
| 到期投递 | `sendBatch` 入队，consumer 发送 | 请求的 `waitUntil` 里发送 |
| 重试 | 新的延迟队列消息（秒级） | 存为 `scheduled`，Cron 到期发送（约 1 分钟） |
| 定时 ≤ 12 h | 延迟队列消息 | Cron |
| 定时 > 12 h | Cron 在进入 12 h 窗口时入队 | Cron |

选了 queue 但没有绑定 `DELIVERY_QUEUE` 时降级为 direct 并打警告，不会让消息卡住。入队失败时投递回到 `scheduled`，下一分钟由 Cron 接手。

## Cron（每分钟）

1. 派发到期（queue 模式：12 h 内到期）的 `scheduled` 投递，先 CAS 改为 `queued` 再入队。
2. `queued` 超过计划时间 15 分钟仍未开始的（入队丢失、进了 DLQ、waitUntil 被截断）改回 `scheduled`。
3. `sending` 租约（60 s）过期的按可重试失败处理。
4. 每小时清理超过保留期且全部投递已结束的消息（投递随外键级联删除；`send_at` 未到或仍有 `scheduled / queued / sending` 投递的消息不删）和统计。积压与旧消息的手动重试同样受保护。

每步最多处理 500 行，积压分几分钟消化。

## 重试与错误分类

`src/channels/http.ts` 统一分类：网络错误、超时（10 s）、408、429、5xx 可重试；其他 4xx 不重试。各渠道再识别业务错误码：飞书 9499/11232、企业微信 45009、钉钉 130101、Telegram `error_code: 429` 视为限流可重试；PushPlus 业务码 500 可重试，900 表示账号受限，按官方要求停止请求；Server酱非零业务码不自动重试。其余业务错误不重试。

退避：10 s、30 s、2 min、10 min、30 min、1 h（之后保持 1 h），总尝试次数由运行设置 `maxAttempts`（默认 5）决定。响应带 `Retry-After`（或 Telegram/Discord 的 `retry_after`）时以它为准，限制在 1 s – 1 h。不做主动限流，靠 429 退避。

错误信息和响应体写入日志前会把渠道的密钥值替换为 `***`（Telegram Bot Token 在 URL 里、Webhook 地址本身常含 token）。

## 渠道渲染

统一消息体 `{title, body, format, level, url, tags, raw}`，适配器负责转换：

| 渠道 | Markdown | 说明 |
| --- | --- | --- |
| Webhook | 原样 | 规范化 JSON；可选 HMAC 签名 `X-Sender-Signature: sha256=HMAC(secret, "ts.body")`，`X-Sender-Delivery` 可用于去重 |
| Telegram | 转 HTML | 超过 4096 字符时退回纯文本截断（截断 HTML 可能留下未闭合标签）；可配反代 API 地址 |
| 飞书 | 卡片 markdown | 标题进卡片头，颜色随 level；text 格式发纯文本；支持签名校验 |
| 企业微信 | 原样 | markdown 4096 / text 2048 字节截断 |
| 钉钉 | 原样 | 支持加签；关键词校验需消息自身包含关键词 |
| Slack | 转 mrkdwn | header + section blocks |
| Discord | 原样 | embed，颜色随 level，禁止 @mention |
| Bark | 去掉标记 | level warn/error → timeSensitive |
| PushPlus | 原样 | markdown / txt 模板；token、channel、topic、option、to 由渠道配置固定；200 仅表示受理，未接最终送达回调 |
| Server酱 | 原样 | SCT / sctp SendKey 自动选择端点；标题单行、最长 32 个 UTF-16 单元；接收人使用平台配置，raw 不能覆盖 channel / openid |
| Email | 转 HTML | Resend，`Idempotency-Key` 用投递 id，重试不会重复发信 |

`raw[渠道类型]` 替换生成的请求体，渠道仍固定路由字段（chat_id、device_key、飞书签名、邮件 from/to/cc/reply_to、PushPlus 凭据与接收目标）。Bark 移除 raw 的 device_key / device_keys，邮件移除 raw 的 from / to / cc / bcc / reply_to（均忽略大小写），再补上已保存的路由，避免受限调用方增加收件人。Server酱从 SendKey 确定端点，并移除 raw 中的 channel / openid，保证接收目标由平台配置决定。

HTTP 请求不跟随重定向，避免凭据转发和额外子请求；应配置最终地址。协议渠道要求明确成功码或消息 ID，Slack 要求 `ok` 文本；2xx 缺少有效确认时按可重试失败处理。通用 Webhook 仍以 HTTP 状态判断成功。诊断内容先对单项请求头、URL 凭据及编码形式脱敏，再截取到 2 KB 保存。

为 Workers Free 的执行预算预留余量：直接发送每次处理 4 个目标，其余转为 scheduled、尝试次数保持不变；Cron 直接模式每分钟处理 4 个到期目标，队列模式每轮派发 20 个，另最多恢复 2 个过期租约。每小时清理最多 5 批、每批 500 条过期消息。队列消费者每批最多 5 条。消息扇出和渠道组绑定用 JSON 批量写入，避免每个目标各占一条 SQL。

## 消息列表

- 按 `(created_at DESC, id DESC)` 稳定排序，`nextBefore` 是包含时间和 id 的不透明游标，原样作为下一页的 `before` 参数传回；仍接受旧的纯时间戳 `before`。多取一行判断是否还有下一页。
- 先按游标、渠道组与状态筛选消息并选出当前页，再聚合该页的投递；状态筛选通过 `message_id` 索引逐条检查，避免先截取有限条消息再筛选造成漏结果。新增迁移为普通列表与渠道组列表分别建立联合索引。
- 后台首屏有未完成投递时每 5 秒刷新，否则每 30 秒刷新；已加载多页时按页数延长间隔，限制历史浏览产生的重复请求。发送、取消和重试仍会主动刷新缓存。

## 统计

`delivery_stats` 按（`send_at` 所在分钟, 渠道, 渠道组）累加最终结果：送达、失败、重试次数、送达延迟（`send_at` → 送达）。24h/7d 按小时、30d/90d 按查看者时区的自然日聚合；分钟粒度保留半小时、四分之一小时等时区的日界线，自然日使用当地日期的第一个真实时刻，处理午夜因夏令时跳过或重复的情况。查询先在 D1 聚合为展示桶，再返回 Worker，避免把每分钟的所有记录加载到内存。手动重试从同一个分钟桶撤回旧失败，日志清理不影响尚在统计保留期内的计数。
