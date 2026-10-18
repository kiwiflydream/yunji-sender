# 本地开发与验证

[返回 README](../README.md)

## 启动开发环境

需要 Node.js 22.12 及以上和 pnpm 10.34.4，版本约束见 [package.json](../package.json)。在项目目录执行：

```sh
pnpm install
cp .dev.vars.example .dev.vars
```

按照 [.dev.vars.example](../.dev.vars.example) 填写 `ENCRYPTION_KEY` 和 `ADMIN_PASSWORD`，再启动本地服务：

```sh
pnpm db:migrate:local
pnpm dev
```

打开 `http://localhost:5173/admin`，使用 `admin` 和 `.dev.vars` 中的密码登录。端口被占用时，以 Vite 输出地址为准。本地开发无需 Cloudflare 登录，也无需预先创建线上数据库或队列。

本地迁移操作本地 D1，部署脚本才会应用远端迁移。`.dev.vars` 不会自动上传为线上密钥，不要提交真实凭据。

手动触发本地 Cron：

```sh
curl 'http://localhost:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*'
```

## 验证命令

| 命令 | 覆盖范围 |
| --- | --- |
| `pnpm typecheck` | Worker、前端、单元测试与浏览器测试四套 TypeScript 配置 |
| `pnpm test` | 在 workerd 中运行 Vitest，并在可终止的独立线程中检查 Markdown 恶意输入性能 |
| `pnpm build` | 构建 Worker 和前端静态资源 |
| `pnpm check` | 依次执行类型检查、单元测试和构建 |
| `pnpm test:e2e` | 构建独立临时环境，运行真实本地 Worker 与模拟渠道的浏览器、API 测试 |
| `pnpm check:release` | 完整发布前检查：`check` 与 `test:e2e` |
| `pnpm cf-typegen` | 修改 Wrangler 配置后重新生成 `worker-configuration.d.ts` |

首次运行浏览器测试，先安装 Chromium：

```sh
pnpm exec playwright install chromium
pnpm check:release
```

Linux CI 可使用 `pnpm exec playwright install --with-deps chromium` 安装系统依赖。

浏览器测试使用空 D1、随机测试密钥和本地模拟渠道，不读取开发数据库或真实渠道凭据，结束后清理临时环境。覆盖中英文桌面与手机页面、模板预览、侧栏及图标，以及队列消费、直接发送、定时取消、失败重试、Cron 补偿、API Key 权限和幂等。

失败时截图和 trace 保存到已忽略的 `test-results/`。GitHub CI 在 push 和 pull request 时执行 `pnpm check:release`，无需部署密钥；失败附件保留 7 天。

## 发布

`pnpm run deploy` 依次执行 `pnpm check`、远端 D1 迁移和 Wrangler 发布。它不会运行浏览器测试；发布前在本机或 CI 完成 `pnpm check:release`。

首次上线还需在目标 Cloudflare 环境验收登录、真实渠道投递、定时消息、失败重试与统计。本地模拟渠道通过不代表真实渠道已通过验收。

## 项目结构

```text
src/
  channels/   渠道适配器与 HTTP 错误分类
  delivery/   投递认领、重试、队列和直接派发
  domain/     渠道、渠道组、API Key、消息、模板与统计
  routes/     HTTP API 与后台入口
  shared/     前后端共用类型、模板和渠道元数据
web/src/      React 管理后台
migrations/   D1 迁移
test/         workerd 单元测试
e2e/          Playwright 浏览器与 API 测试
```

后端使用 Hono、Cloudflare Workers、Queues 和 D1，后台使用 React、Kumo、TanStack Query 和 ECharts，由 Vite 与 Cloudflare Vite 插件构建。实现细节见[架构设计](design.md)。
