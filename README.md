# cf-sender

运行在 Cloudflare 上的多渠道通知网关：一个 API 发消息，按主题扇出到 Webhook、Telegram、飞书、企业微信、钉钉、Slack、Discord、Bark、PushPlus、Server酱、Email（Resend）。失败自动退避重试，支持定时发送、幂等键、投递记录与统计图表，[Kumo](https://github.com/cloudflare/kumo) 管理后台。设计见 [docs/design.md](docs/design.md)。

技术栈：Hono · Workers · Queues（投递与重试，可关闭）· D1（配置、日志、统计）· Cron（定时消息、补偿、清理）；后台是 React + Kumo 单页应用，由 Vite + `@cloudflare/vite-plugin` 构建为 Workers 静态资源。

```
src/
  channels/   渠道适配器（每个渠道一个文件）与 HTTP 错误分类
  delivery/   投递状态机：认领、重试、派发（队列 / 直接）
  domain/     渠道、主题、API Key、消息、统计
  routes/     /api（API Key）与 /admin（后台）
  shared/     Worker 与前端共用的类型和渠道元数据
web/src/      后台前端
migrations/   D1 迁移
test/         vitest（在 workerd 中运行）
```

## 发送

```sh
curl -X POST https://<worker>/api/send \
  -H "Authorization: Bearer cfs_..." \
  -H "Idempotency-Key: deploy-1234" \
  -H "Content-Type: application/json" \
  -d '{"topic":"ops-alert","title":"部署失败","body":"**api** 回滚到 v1.2","format":"markdown","level":"error"}'
```

| 字段 | 说明 |
| --- | --- |
| `topic` | 主题标识，消息发到它绑定的所有已启用渠道 |
| `channels` | 渠道 id 数组，可与 `topic` 同时使用（去重） |
| `title` / `body` | 至少一个；`body` 最长 16 KB |
| `format` | `text`（默认）或 `markdown`，各渠道自动转换或降级 |
| `level` | `info`（默认）/ `warn` / `error`，影响标题前缀、卡片颜色、邮件主题等 |
| `url` / `tags` | 可选的链接和标签（最多 10 个） |
| `sendAt` | 毫秒时间戳或 ISO 8601，最多提前 365 天；省略或已过去则立即发送 |
| `raw` | 按渠道类型覆盖请求体，如 `{"feishu": {"msg_type": "post", ...}}`；路由字段（chat_id、device_key、签名、收件人）仍由渠道补上 |

返回 `202 { messageId, deliveries: [...] }`；相同 API Key + `Idempotency-Key` 的重复请求返回 `200` 和原消息（`duplicate: true`）。`GET /api/messages/:id` 查询投递状态，`POST /api/messages/:id/cancel` 取消尚未开始的投递。

同账号下的 Worker 可以用 Service Binding 调用，不需要 API Key：

```jsonc
// 调用方的 wrangler.jsonc
"services": [{ "binding": "SENDER", "service": "cf-sender", "entrypoint": "SenderRpc" }]
```

```ts
await env.SENDER.send({ topic: 'ops-alert', title: '任务失败', body: '...', level: 'error' }, { idempotencyKey: runId })
```

## 本地开发

需要 Node.js ≥ 22.12 和 pnpm 10.34.4（版本固定在 `package.json`）。

```sh
pnpm install
cp .dev.vars.example .dev.vars   # 填入 ENCRYPTION_KEY：openssl rand -base64 32
pnpm db:migrate:local
pnpm dev                          # http://localhost:5173/admin（admin / .dev.vars 里的 ADMIN_PASSWORD）
```

```sh
pnpm test        # vitest，在 workerd 中运行
pnpm typecheck   # Worker、前端、测试三套 tsconfig
pnpm build
pnpm check       # 依次执行 typecheck、test、build；CI 和 deploy 共用此检查
pnpm cf-typegen  # 修改 wrangler.jsonc 后重新生成 worker-configuration.d.ts
```

本地手动触发 Cron：`curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`。

## 部署

```sh
wrangler d1 create cf-sender                    # 把输出的 database_id 填进 wrangler.jsonc
wrangler queues create cf-sender-deliveries      # 不用队列方式时不需要这两个队列
wrangler queues create cf-sender-deliveries-dlq
pnpm db:migrate:remote
wrangler secret put ENCRYPTION_KEY               # openssl rand -base64 32；丢失后已存渠道凭证无法解密
wrangler secret put ADMIN_PASSWORD               # 后台 basic 认证密码
pnpm run deploy
```

后续更新新增迁移时，也需要先执行 `pnpm db:migrate:remote`，再部署。`deploy` 会先运行完整检查，通过后才发布；GitHub CI 在 push 和 pull request 时运行相同检查，无需部署密钥。

部署后在后台创建渠道、主题和 API Key。

**PushPlus**：添加渠道时填入用户 Token 或消息 Token，默认推送到自己的微信公众号。可选填 PushPlus 群组编码、接收渠道、渠道配置编码和指定接收人；群组编码与本系统的主题独立。选择短信、语音渠道会使用 PushPlus 的付费服务。Token 和指定接收人加密保存。[官方接口文档](https://pushplus.plus/doc/guide/api.html)

**Server酱**：填入 SendKey，自动识别 Turbo 的 `SCT...` 和 Server酱³ 的 `sctp{uid}t...`；接收通道在 Server酱平台配置。SendKey 加密保存，消息正文支持 Markdown；缺少标题时从正文生成，标题整理为单行并截断至 32 个 UTF-16 单元。[SendKey 获取说明](https://sct.ftqq.com/docs/getting-started/sendkey/)

这两个渠道在后台都支持「发送测试消息」。投递成功表示上游 API 已受理；其中 PushPlus 异步发送，本项目尚未接入其最终送达回调。账号受限、凭据错误等业务失败会记录原因；网络错误、HTTP 429/5xx 和 PushPlus 系统异常会自动重试，PushPlus `900` 账号受限会停止重试。

**不用 Queues（例如免费套餐）**：删掉 wrangler.jsonc 的 `queues` 段，运行 `pnpm cf-typegen`，在后台「设置」选择「直接发送」。到期的消息在请求的 `waitUntil` 里发送；定时消息和重试由每分钟的 Cron 处理，精度约 1 分钟。

**后台认证**：默认 basic（`ADMIN_USERNAME` + `ADMIN_PASSWORD`）。改用 Cloudflare Access：设置 `ADMIN_AUTH_MODE=access`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`，并在 Access 里保护 `/admin*`（不要保护 `/api/*`，它用 API Key 认证）。
