# 云吉 Sender · Yunji Sender

[简体中文](README.md) · [English](README.en.md)

部署在 Cloudflare 上的多渠道通知网关。

业务系统只需调用一个 API，即可把订单通知、部署结果或服务告警发送到多个渠道。接收人、消息模板和失败重试在后台统一管理，无需在每个项目中分别接入通知服务，也无需维护常驻服务器。

[快速部署](#快速部署) · [发送第一条消息](#发送第一条消息) · [接入指南](docs/usage.md) · [本地开发](docs/development.md)

> **正式部署推荐使用 Cloudflare Access 管理后台登录与访问授权。** 通过 Access 策略限定可访问的身份，并将 `ADMIN_AUTH_MODE` 设置为 `access`。默认 Basic 认证仅作为本地开发或快速试用的简便方式；配置方法见下方部署步骤。Access 保护后台，业务 API 仍使用独立 API Key。

## 功能

- **多渠道发送**：同一条消息可发送到多个目标，分别记录结果并处理失败重试。
- **渠道组**：为通知目标设置稳定标识，业务代码只传 `channelGroup`，调整接收人时修改组内绑定即可。
- **消息模板**：内置订单、支付、发货、部署和告警模板，传入业务变量即可发送，也可创建自己的模板。
- **定时与幂等**：支持预约发送、取消尚未开始的投递，以及通过幂等键避免重复创建消息。
- **投递记录与统计**：查看各渠道的状态、尝试次数和错误原因，按渠道、渠道组统计投递结果与延迟。
- **凭据与权限**：渠道凭据加密保存，API Key 可按渠道组限制发送权限；同账号 Worker 支持 Service Binding 调用。
- **费用保护**：可配置每日投递额度、调用方额度、积压上限和共享执行预算，支持暂停发送；入口限流、有限重试及超时控制减少异常请求带来的消耗。
- **管理界面**：支持简体中文、English 和移动端，内置可复制示例的 API 文档。

## 支持的渠道

| 类别 | 渠道 |
| --- | --- |
| 聊天与协作 | Telegram、飞书 / Lark、企业微信、钉钉、Slack、Discord |
| 手机与微信推送 | Bark、PushPlus、Server 酱 |
| 邮件 | Email（Resend） |
| 自定义接入 | Webhook，可配置请求头和 HMAC 签名 |

消息支持纯文本和 Markdown，各渠道会按自身能力转换或降级。渠道配置与发送边界见[接入指南](docs/usage.md)。

## 快速部署

准备一个 Cloudflare 账号，以及 Node.js 22.12 及以上、pnpm 10.34.4。下载或克隆本项目后，在项目目录操作；pnpm 版本已固定在 `package.json`。

### 1. 安装依赖并登录

```sh
pnpm install
pnpm exec wrangler login
```

### 2. 创建数据库

```sh
pnpm exec wrangler d1 create yunji-sender
```

将命令返回的 `database_id` 填入 [wrangler.jsonc](wrangler.jsonc)，替换原有的全零占位值。

### 3. 创建队列

默认通过 Cloudflare Queues 投递消息，创建执行队列和死信队列：

```sh
pnpm exec wrangler queues create yunji-sender-deliveries
pnpm exec wrangler queues create yunji-sender-deliveries-dlq
```

如果只用直接发送，可删除 `wrangler.jsonc` 中整个 `queues` 配置段，执行 `pnpm cf-typegen`，并跳过队列创建。两种方式的区别见[投递方式与运行配置](docs/execution.md)。

### 4. 配置后台认证与加密密钥

**推荐使用 Cloudflare Access，集中管理后台登录与访问策略。** 在 Cloudflare Zero Trust 中创建 Self-hosted 应用，覆盖实际访问域名的 `/admin` 和 `/admin/*`，并配置仅允许指定邮箱、用户组或身份提供商身份的策略。确认应用覆盖后台根路径和所有子路径，包括 `/admin/api/*`。

在 `wrangler.jsonc` 的 `vars` 中设置：

```json
{
  "ADMIN_AUTH_MODE": "access",
  "ACCESS_TEAM_DOMAIN": "your-team.cloudflareaccess.com",
  "ACCESS_AUD": "your-application-audience-tag"
}
```

`ACCESS_TEAM_DOMAIN` 不带 `https://` 或路径；`ACCESS_AUD` 来自该 Access 应用。Worker 会验证 Access JWT 的签名、签发者和应用受众；Access 模式配置缺失或令牌无效时拒绝访问，不会退回 Basic。Access 策略决定谁能进入后台；当前后台没有进一步的角色分级，获准进入的用户均拥有管理权限。

不要把业务 `/api/*` 纳入要求交互登录的后台 Access 应用；这些请求继续使用 Sender API Key。若同时开放自定义域名、`workers.dev` 或预览地址，需逐一核对后台访问入口的保护范围。详细步骤见 [Access 官方配置指南](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。

所有认证模式都需要设置渠道凭据加密密钥：

```sh
pnpm exec wrangler secret put ENCRYPTION_KEY
```

按提示输入用 `openssl rand -base64 32` 生成的密钥并妥善备份。密钥丢失或更换后，原有渠道凭据将无法解密。首次设置时，如果提示创建同名 Worker，确认创建后继续即可。

本地开发或快速试用可保留默认 `ADMIN_AUTH_MODE: "basic"`，再执行以下命令设置独立强密码，用户名默认 `admin`：

```sh
pnpm exec wrangler secret put ADMIN_PASSWORD
```

Access 模式无需 `ADMIN_PASSWORD`。发送消息用的 API Key 在后台创建，无需作为部署密钥填写。

### 5. 部署并打开后台

```sh
pnpm run deploy
```

此命令会依次运行类型检查、单元测试和构建，初始化 D1 表结构，再发布 Worker。部署完成后，打开输出地址的 `/admin`，按 Access 策略完成身份验证；选择 Basic 模式时，使用 `admin` 和刚设置的 `ADMIN_PASSWORD` 登录。

发布前的完整验证命令为 `pnpm check:release`，浏览器安装和验证范围见[本地开发](docs/development.md)。

## 发送第一条消息

1. 在「渠道」页添加一个通知目标，填写凭据并点击「测试」。
2. 在「渠道组」页添加标识为 `ops-alert` 的组，绑定刚创建的渠道。
3. 在「API Key」页创建 Key，允许它发送到 `ops-alert`，并保存生成的完整令牌。
4. 将下面的部署地址和 API Key 替换成自己的值，发送消息。

```sh
export SENDER_BASE_URL="https://your-worker.workers.dev"
export SENDER_API_KEY="cfs_replace_with_your_key"

curl "$SENDER_BASE_URL/api/send" \
  -H "Authorization: Bearer $SENDER_API_KEY" \
  -H 'Idempotency-Key: readme-first-message-1' \
  -H 'Content-Type: application/json' \
  -d '{
    "channelGroup": "ops-alert",
    "title": "第一条通知",
    "body": "云吉 Sender 已接入",
    "level": "info"
  }'
```

首次提交返回 `202` 和 `messageId`，表示消息已受理。使用同一 API Key 和幂等键重试会返回原消息；发送新事件时应换一个键。投递结果可在后台查看，也可通过 `GET /api/messages/:id` 查询。

## 文档

- [接入指南](docs/usage.md)：HTTP API、消息模板、Service Binding、渠道配置与错误码。
- [投递方式与运行配置](docs/execution.md)：队列与直接发送、定时与重试、保留设置、认证及费用。
- [本地开发与验证](docs/development.md)：开发环境、测试命令、发布检查和项目结构。
- [架构设计](docs/design.md)：消息模型、投递状态机、补偿、渠道适配和统计实现。

部署后的 `/admin/api-docs` 提供完整 HTTP 接入说明，示例会自动使用当前部署地址。

## 费用保护与入口限流

后台「设置 › 费用保护」可即时调整：每日全局投递上限（默认 1000）、每个调用方每日上限（500）、每分钟上限（100）、最大待处理投递数（1000）和每日执行预算（3000），也可暂停发送。额度按目标渠道计数；每次入队和实际发送各消耗一次执行预算，重试、补偿和渠道测试共用。日额度按 UTC 零点重置。

入口限流在认证和 D1 查询前执行，配置位于 `wrangler.jsonc` 的 `ratelimits`：每个 IP 每类入口每分钟 300 次、每类入口合计 1000 次，统计接口另限每分钟 30 次。修改后需重新部署；同一账户部署多个实例时使用独立的 `namespace_id`。统计缓存 60 秒，显示可能稍有延迟。

这些保护不是金额硬上限：原生限流按 Cloudflare 节点计数，Worker 请求、存储和外部渠道仍可能计费。正式部署还应配置适合业务的边缘防护并观察用量。完整配置、超时和重试上限见[投递方式与运行配置](docs/execution.md)。

## 使用边界

投递成功表示对应渠道服务已受理，实际终端送达以渠道为准。定时发送时间也不代表精确送达时间，排队、平台调度和重试都可能带来延迟。

消息记录按保留天数清理；清理后，对应幂等键不再阻止创建新消息。接收 Webhook 的业务系统应结合投递标识处理重复请求。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。
