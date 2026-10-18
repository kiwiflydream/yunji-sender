# 云吉 Sender · Yunji Sender

运行在 Cloudflare 上的多渠道通知网关：一个 API 发消息，按渠道组扇出到 Webhook、Telegram、飞书、企业微信、钉钉、Slack、Discord、Bark、PushPlus、Server酱、Email（Resend）。失败自动退避重试，支持变量消息模板、定时发送、幂等键、投递记录与统计图表，[Kumo](https://github.com/cloudflare/kumo) 管理后台。设计见 [docs/design.md](docs/design.md)。

技术栈：Hono · Workers · Queues（投递与重试，可关闭）· D1（配置、日志、统计）· Cron（定时消息、补偿、清理）；后台是 React + Kumo 单页应用，由 Vite + `@cloudflare/vite-plugin` 构建为 Workers 静态资源。

```
src/
  channels/   渠道适配器（每个渠道一个文件）与 HTTP 错误分类
  delivery/   投递状态机：认领、重试、派发（队列 / 直接）
  domain/     渠道、渠道组、API Key、消息、统计
  routes/     /api（API Key）与 /admin（后台）
  shared/     Worker 与前端共用的类型和渠道元数据
web/src/      后台前端
migrations/   D1 迁移
test/         vitest（在 workerd 中运行）
```

## 界面语言

后台支持简体中文和 English，首次访问按浏览器语言选择（其他语言回退到英文）。侧栏底部、手机顶部的语言按钮或「设置 → 界面语言」均可切换，手动选择保存在当前浏览器。切换语言会保留未保存的表单内容；渠道名称、消息和已保存的模板文案保持原样。

## 发送

后台「API 文档」（`/admin/api-docs`）提供完整的 HTTP 接入说明，覆盖认证、自定义消息、模板、查询、取消、定时、幂等和错误码。页面中的 cURL 示例使用当前部署地址，并支持一键复制。

```sh
curl -X POST https://<worker>/api/send \
  -H "Authorization: Bearer cfs_..." \
  -H "Idempotency-Key: deploy-1234" \
  -H "Content-Type: application/json" \
  -d '{"channelGroup":"ops-alert","title":"部署失败","body":"**api** 回滚到 v1.2","format":"markdown","level":"error"}'
```

| 字段 | 说明 |
| --- | --- |
| `channelGroup` | 渠道组标识，消息发到它绑定的所有已启用渠道 |
| `channels` | 渠道 id 数组，可与 `channelGroup` 同时使用（去重） |
| `title` / `body` | 至少一个；`body` 按 UTF-8 编码最多 16 KB（16,384 字节） |
| `format` | `text`（默认）或 `markdown`，各渠道自动转换或降级 |
| `level` | `info`（默认）/ `warn` / `error`，影响标题前缀、卡片颜色、邮件主题等 |
| `url` / `tags` | 可选的链接和标签（最多 10 个） |
| `sendAt` | 毫秒时间戳或 ISO 8601，最多提前 365 天；省略或已过去则立即发送 |
| `raw` | 按渠道类型覆盖请求体，如 `{"feishu": {"msg_type": "post", ...}}`；路由字段（chat_id、device_key、签名、收件人）仍由渠道补上 |

正文、raw 和模板变量按 UTF-8 字节计量，1 KB = 1,024 字节。`raw` 序列化后最多 32 KB；Bark 和 Email 会过滤 raw 中非 ASCII 的顶层字段名，字段值仍支持中文和表情。模板的单个字符串变量最多 16 KB、整个变量对象序列化后最多 32 KB，展开后的正文最多 16 KB。HTTP JSON 请求体整体最多 256 KB（包含 JSON 转义），超出返回 `413 { error: "payload_too_large", maxBytes: 262144 }`，字段内容超限返回 `422`。

返回 `202 { messageId, deliveries: [...] }`；相同 API Key + `Idempotency-Key` 的重复请求返回 `200` 和原消息（`duplicate: true`）。`GET /api/messages/:id` 查询投递状态，`POST /api/messages/:id/cancel` 取消尚未开始的投递。

### 模板发送

后台「模板」内置 5 个可编辑模板：

| 模板 ID | 用途 | 必需变量 |
| --- | --- | --- |
| `new-order` | 新订单通知 | `orderNo` |
| `payment-success` | 支付成功 | `orderNo`、`amount` |
| `order-shipped` | 发货通知 | `orderNo`、`carrier`、`trackingNo` |
| `deployment-result` | 部署结果 | `service`、`environment`、`version`、`result` |
| `service-alert` | 服务告警 | `service`、`message`、`time` |

先编辑模板，设置默认渠道或渠道组。以后只需传模板 ID 和变量，无需在业务系统中拼接文案：

```sh
curl -X POST https://<worker>/api/send \
  -H "Authorization: Bearer cfs_..." \
  -H "Idempotency-Key: order-202610170001" \
  -H "Content-Type: application/json" \
  -d '{"templateId":"new-order","variables":{"orderNo":"202610170001"}}'
```

模板标题、正文使用 `{{variableName}}`，变量名以英文字母开头，只含字母、数字和下划线；支持字符串、数字、布尔值，不支持嵌套对象或表达式。缺失或空白变量返回 `422`，不会创建消息。模板 ID 创建后固定，`new` 为保留标识。

默认模板不绑定接收人。未设置默认目标时，可在请求中指定 `channels` 或 `channelGroup`；指定任一目标字段会完整替换模板默认目标，不会额外发给原目标。API Key 的渠道组权限仍对最终目标生效。模板调用可附带 `sendAt`，并支持原有幂等键；不能同时传入 `title`、`body`、`raw` 等内容字段，格式和级别在模板中设置。

后台「发送消息 → 使用模板」可以填写变量、预览和发送；模板编辑页也提供预览和可复制的 API 请求示例。消息提交时保存渲染后的内容和投递目标，之后修改或删除模板不会影响已提交消息、重试或相同幂等键的重复请求。RPC 的 `send()` 支持相同的模板参数。

同账号下的 Worker 可以用 Service Binding 调用，不需要 API Key：

```jsonc
// 调用方的 wrangler.jsonc
"services": [{ "binding": "SENDER", "service": "yunji-sender", "entrypoint": "SenderRpc" }]
```

```ts
await env.SENDER.send({ channelGroup: 'ops-alert', title: '任务失败', body: '...', level: 'error' }, { idempotencyKey: runId })
```

## 本地开发

需要 Node.js ≥ 22.12 和 pnpm 10.34.4（版本固定在 `package.json`）。

```sh
pnpm install
cp .dev.vars.example .dev.vars   # 填入 ENCRYPTION_KEY 和 ADMIN_PASSWORD，生成方式见文件注释
pnpm db:migrate:local
pnpm dev                          # http://localhost:5173/admin（admin / .dev.vars 里的 ADMIN_PASSWORD）
```

```sh
pnpm test        # vitest，在 workerd 中运行
pnpm typecheck   # Worker、前端、单元测试、浏览器测试四套 tsconfig
pnpm build
pnpm check       # 依次执行 typecheck、test、build
pnpm exec playwright install chromium  # 首次安装浏览器；Linux CI 加 --with-deps
pnpm test:e2e    # 独立临时目录构建、空 D1、随机测试密钥和本地模拟渠道
pnpm check:release # 完整发布前检查：check + test:e2e；CI 使用此命令
pnpm cf-typegen  # 修改 wrangler.jsonc 后重新生成 worker-configuration.d.ts
```

浏览器测试覆盖中英文桌面和手机页面、模板字节预览、网站图标、侧栏开合，以及队列消费、直发、定时取消、失败重试、Cron 补偿、API Key 权限和幂等。测试不会读取开发库或真实渠道凭证，结束后清理临时环境；失败时截图和 trace 保存到已忽略的 `test-results/`，CI 保留 7 天。

本地手动触发 Cron：`curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`。

## 部署

### 一键部署

发布到 GitHub 或 GitLab 后，使用实际仓库 URL 生成部署链接：`https://deploy.workers.cloudflare.com/?url=<URL 编码后的仓库地址>`。按 [Cloudflare 官方文档](https://developers.cloudflare.com/workers/platform/deploy-buttons/) 打开生成的链接并部署：

1. 登录 Cloudflare，授权 GitHub 或 GitLab，将项目复制到自己的仓库。
2. 确认 Worker、D1 和 Queue 的名称，Cloudflare 会根据 `wrangler.jsonc` 创建并绑定资源。
3. 填写下面两个密钥，再确认部署。

| 密钥 | 填写方式 |
|---|---|
| `ADMIN_PASSWORD` | 设置独立的强密码，用于后台登录，默认用户名为 `admin` |
| `ENCRYPTION_KEY` | 用 `openssl rand -base64 32` 生成，用于加密渠道凭证；妥善保存，更换后已存渠道凭证将无法解密 |

构建和部署命令会从 `package.json` 自动读取，保留默认值即可。部署脚本会运行完整检查、执行尚未应用的 D1 迁移，再发布 Worker。部署成功后打开应用地址的 `/admin`，用 `admin` 和刚设置的 `ADMIN_PASSWORD` 登录，在后台创建渠道、渠道组和 API Key。API Key 在后台生成，无需作为部署密钥填写。

### 命令行部署

发布前先运行 `pnpm check:release`。以下命令操作真实 Cloudflare 资源，需先确认账号；`wrangler.jsonc` 中的全零 D1 ID 是首次部署配置占位值，必须替换为创建的数据库 ID。

```sh
wrangler d1 create yunji-sender                    # 把输出的 database_id 填进 wrangler.jsonc
wrangler queues create yunji-sender-deliveries      # 不用队列方式时不需要这两个队列
wrangler queues create yunji-sender-deliveries-dlq
wrangler secret put ENCRYPTION_KEY               # openssl rand -base64 32；丢失后已存渠道凭证无法解密
wrangler secret put ADMIN_PASSWORD               # 后台 basic 认证密码
pnpm run deploy                                # 完整检查、执行 D1 迁移并发布 Worker
```

后续更新时运行 `pnpm run deploy`，脚本会先运行完整检查，再应用新增迁移并发布。GitHub CI 在 push 和 pull request 时运行 `pnpm check:release`，无需部署密钥。Cloudflare 构建环境中的部署脚本运行 `pnpm check`，浏览器验收由 CI 和发布前的 `check:release` 完成。

部署后在后台创建渠道、渠道组和 API Key。首次上线还需在实际部署环境验证登录、真实渠道投递、定时任务、失败重试和统计；本地模拟渠道通过只表示本地链路通过。

**PushPlus**：添加渠道时填入用户 Token 或消息 Token，默认推送到自己的微信公众号。可选填 PushPlus 群组编码、接收渠道、渠道配置编码和指定接收人；群组编码与本系统的渠道组独立。选择短信、语音渠道会使用 PushPlus 的付费服务。Token 和指定接收人加密保存。[官方接口文档](https://pushplus.plus/doc/guide/api.html)

**Server酱**：填入 SendKey，自动识别 Turbo 的 `SCT...` 和 Server酱³ 的 `sctp{uid}t...`；接收通道在 Server酱平台配置。SendKey 加密保存，消息正文支持 Markdown；缺少标题时从正文生成，标题整理为单行并截断至 32 个 UTF-16 单元。[SendKey 获取说明](https://sct.ftqq.com/docs/getting-started/sendkey/)

这两个渠道在后台都支持「发送测试消息」。投递成功表示上游 API 已受理；其中 PushPlus 异步发送，本项目尚未接入其最终送达回调。账号受限、凭据错误等业务失败会记录原因；网络错误、HTTP 429/5xx 和 PushPlus 系统异常会自动重试，PushPlus `900` 账号受限会停止重试。

**Queues 免费额度**：Workers Free 已支持 Queues，包含每天 10,000 次操作，消息保留 24 小时。一次正常投递通常涉及写入、读取、删除共 3 次操作，无重试时约可完成 3,333 次渠道投递；本项目按目标渠道分别入队，发往多个渠道和重试都会增加用量。详见 [Cloudflare Queues 官方计费说明](https://developers.cloudflare.com/queues/platform/pricing/)。

**不用 Queues**：删掉 wrangler.jsonc 的 `queues` 段，运行 `pnpm cf-typegen`，在后台「设置」选择「直接发送」。每次请求最多在 `waitUntil` 中投递 4 个目标，其余等待每分钟的 Cron；Cron 每轮最多处理 4 个到期投递（含定时、重试和积压），未轮到的任务不消耗尝试次数。精度约 1 分钟，积压会延迟；较多投递建议使用队列模式。

**后台认证**：默认 basic（`ADMIN_USERNAME` + `ADMIN_PASSWORD`）。改用 Cloudflare Access：设置 `ADMIN_AUTH_MODE=access`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`，并在 Access 里保护 `/admin*`（不要保护 `/api/*`，它用 API Key 认证）。
