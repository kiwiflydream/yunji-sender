# 云吉 Sender（Yunji Sender）设计

## 模型

- **渠道 channel**：一个投递目标（某个飞书群机器人、某个 Telegram 会话、某组邮箱）。字段由 `src/shared/catalog.ts` 描述，后台表单和服务端校验都从这里生成。标记为 `secret` 的字段整体 AES-GCM 加密存入 `secrets_encrypted`（AAD 绑定渠道 id），接口永不返回，编辑时留空表示保留原值。渠道类型创建后不能修改。
- **渠道组 channelGroup**：渠道的命名分组。调用方只写 `channelGroup`，改接收人只改绑定。标识创建后不可修改，名称和绑定可编辑，避免破坏模板及 API Key 的引用。
- **API Key**：`cfs_` 前缀，只存 SHA-256；可限定只能发送到某些渠道组（此时不能直接指定渠道）。`last_used_at` 每分钟最多写一次。
- **消息 message**：一次发送请求，存规范化内容和 `send_at`。
- **投递 delivery**：消息 × 渠道，独立状态、重试和结果。渠道名和渠道组是快照，渠道删除后日志仍可读。

## 消息模板

- `message_templates` 保存稳定的模板 ID、名称、说明、标题/正文、格式、级别和默认发送目标。初始化脚本 `0001_init.sql` 预置新订单、支付成功、发货、部署和服务告警五个模板；默认不绑定接收人，后台可直接编辑。模板 CRUD 仅开放在受认证保护的 `/admin/api/templates`。
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

选了 queue 但没有绑定 `DELIVERY_QUEUE` 时降级为 direct 并打警告，不会让消息卡住。入队失败或 10 秒内未确认结果时投递回到 `scheduled`，保留派发次数和退避时间，由 Cron 接手。

## Cron（每分钟）

1. 先将超过 `deadline_at` 或耗尽 12 次派发的待处理投递转为失败，每轮最多 20 条。
2. 未暂停时，派发到期且 `dispatch_after` 已到的 `scheduled` 投递，先 CAS 改为 `queued`，再原子预留派发次数和工作预算后入队。
3. `queued` 在 `max(next_attempt_at, last_dispatched_at)` 后 15 分钟仍未开始的改回 `scheduled`，每轮最多 20 条。
4. `sending` 租约（60 s）过期的按可重试失败处理，每轮最多 2 条。
5. 每小时分批清理已结束的过期消息、统计和两天前的额度计数，暂停期间仍执行清理。

Cron 的 scheduled、queued、sending 查询分别使用与条件匹配的部分索引，避免扫描已完成历史；回归测试同时检查 SQL 次数与实际 `rows_read`。

队列派发每轮最多 20 条，直接发送每轮最多 4 条；各步均有查询预算测试，积压分多轮消化。

`usage_counters` 的接收额度由消息插入触发器预留，执行预算由派发次数和发送尝试次数更新触发器预留，渠道测试也使用同一执行预算。计数与业务状态在同一事务中提交，配额异常通过 `safety:*` 分类；拒绝接收时整个消息事务回滚，已受理任务则延后到预算恢复或最终到期。见[费用保护配置](execution.md#费用保护)。

## 重试与错误分类

`src/channels/http.ts` 统一分类：网络错误、超时（10 s）、408、429、5xx 可重试；其他 4xx 不重试。各渠道再识别业务错误码：飞书 9499/11232、企业微信 45009、钉钉 130101、Telegram `error_code: 429` 视为限流可重试；PushPlus 业务码 500 可重试，900 表示账号受限，按官方要求停止请求；Server酱非零业务码不自动重试。其余业务错误不重试。

退避：10 s、30 s、2 min、10 min、30 min、1 h（之后保持 1 h），总尝试次数由运行设置 `maxAttempts`（默认 5）决定。响应带 `Retry-After`（或 Telegram/Discord 的 `retry_after`）时以它为准，限制在 1 s – 1 h。新投递入口另有全局、调用方与积压限制，所有执行受每日共享工作预算限制；不额外按上游渠道做速率整形。

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

- 按 `(created_at DESC, id DESC)` 稳定排序，`nextBefore` 是包含时间和 id 的不透明游标，原样作为下一页的 `before` 参数传回，不接受纯时间戳。多取一行判断是否还有下一页。
- 先按游标、渠道组与状态筛选消息并选出当前页，再聚合该页的投递；状态筛选使用事务内维护的 `delivery_state` 及联合游标索引，直接定位匹配消息，避免逐条聚合历史投递。初始化脚本同时提供带渠道组条件的状态游标索引。
- 后台首屏有未完成投递时每 5 秒刷新，否则每 30 秒刷新；已加载多页时按页数延长间隔，限制历史浏览产生的重复请求。发送、取消和重试仍会主动刷新缓存。

## 统计

`delivery_stats` 按（`send_at` 所在分钟, 渠道, 渠道组）累加最终结果：送达、失败、重试次数、送达延迟（`send_at` → 送达）。24h/7d 按小时、30d/90d 按查看者时区的自然日聚合；分钟粒度保留半小时、四分之一小时等时区的日界线，自然日使用当地日期的第一个真实时刻，处理午夜因夏令时跳过或重复的情况。查询先在 D1 聚合为展示桶，再返回 Worker，避免把每分钟的所有记录加载到内存。手动重试从同一个分钟桶撤回旧失败，日志清理不影响尚在统计保留期内的计数。

## D1 查询与索引

查询计划和实际读行数要一起检查；`LIMIT` 只限制结果，`SCAN ... USING INDEX` 也可能遍历整个索引。

| 查询路径 | 索引策略 |
| --- | --- |
| 即将到期的调度、队列恢复、发送租约 | 分别匹配状态条件的部分索引；队列恢复匹配时间表达式索引 |
| 到期终止、派发耗尽 | 两个互斥的 `UNION ALL` 分支，分别按截止时间范围和耗尽任务的部分索引查询；整体限制每轮数量 |
| 额度计数清理 | `usage_counters(bucket)` 范围索引，避免扫描当前额度 |
| 消息分页 | 普通、渠道组、状态、渠道组加状态四种联合游标索引 |
| 消息详情、投递关联与级联删除 | 消息主键及 `deliveries(message_id)`；渠道组关联表的正向主键、反向渠道索引 |
| 统计区间与统计清理 | `delivery_stats` 复合主键的 `bucket` 前缀 |
| API Key 认证、配置与模板单条读取 | 唯一键或主键查找 |

渠道、API Key 等完整配置列表，以及统计所需的渠道名称映射，本来就返回全表，顺序扫描并不代表缺少过滤索引。消息状态由五个增量计数和存储生成列维护；投递插入、状态变化及删除的触发器与原操作同事务提交或回滚。读取成本下降的代价是投递写入时增加一次父消息计数更新及必要的索引维护。

手动重试从终态恢复到待处理态时，由数据库触发器原子检查积压容量。拒绝时同时回滚投递状态、截止时间和失败统计的撤回；并发重试不能争抢超过上限的名额。`idx_deliveries_exhausted` 的次数阈值须与 `MAX_DISPATCHES` 保持一致。

回归测试覆盖 1000 条无关历史/未来投递和 1000 条有效额度计数下的空闲维护读行数，以及并发重试、满额回滚。

`delivery_state` 不包含当前时间：全部待处理投递均为 scheduled 时记录 scheduled，查询时再以 `send_at > now` 区分未来定时与已到期 pending。因此时间跨过计划发送点无需写库，也不会等 Cron 才改变筛选结果。状态筛选显式选用对应状态游标索引，避免 SQLite 为满足排序改走渠道组时间索引。pending 查询只检查两类活跃状态，不扫描已完成历史；当前页的展示计数仍由真实投递聚合，便于验证一致性。取消数和 Cron 恢复数使用 `RETURNING` 行数，避免触发器写入放大 `meta.changes`。
