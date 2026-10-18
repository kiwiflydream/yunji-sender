# Development and verification

[简体中文](development.md) · [English](development.en.md)

[Back to README](../README.en.md)

The project has not launched. Treat it as a fresh deployment: update `migrations/0001_init.sql` directly rather than maintaining historical migrations or compatibility branches for old clients.

## Local setup

Use Node.js 22.12 or newer and pnpm 10.34.4; see [package.json](../package.json).

```sh
pnpm install
cp .dev.vars.example .dev.vars
```

Fill in `ENCRYPTION_KEY` and `ADMIN_PASSWORD` following [.dev.vars.example](../.dev.vars.example), then start:

```sh
pnpm db:migrate:local
pnpm dev
```

Open `http://localhost:5173/admin` and log in as `admin` with the password in `.dev.vars`. If the port is busy, use Vite's displayed URL. Local development needs neither Cloudflare login nor pre-created cloud databases or queues.

Local initialization affects local D1 only. The deploy script initializes remote D1. `.dev.vars` is not automatically uploaded as production secrets; never commit real credentials.

Trigger local Cron manually:

```sh
curl 'http://localhost:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*'
```

## Verification commands

| Command | Coverage |
| --- | --- |
| `pnpm typecheck` | Worker, frontend, unit-test and browser-test TypeScript configurations |
| `pnpm test` | Vitest in workerd, plus adversarial Markdown performance checks in terminable threads |
| `pnpm build` | Worker and frontend assets |
| `pnpm check` | Type checks, unit tests and build |
| `pnpm test:e2e` | Real local Worker and mock provider in a temporary environment; browser and API tests |
| `pnpm check:release` | Complete check plus E2E suite |
| `pnpm cf-typegen` | Regenerate `worker-configuration.d.ts` after Wrangler changes |

Install Chromium before the first browser run:

```sh
pnpm exec playwright install chromium
pnpm check:release
```

On Linux CI, use `pnpm exec playwright install --with-deps chromium` to install system dependencies too.

E2E tests use an empty D1 database, random test secrets and a local mock provider. They do not read development databases or real channel credentials and clean up their temporary environment afterward. Coverage includes Chinese and English desktop/mobile pages, template previews, navigation and icons, queue consumption, direct delivery, scheduled cancellation, retries, Cron recovery, API key permissions and idempotency.

HTTP integration tests also exercise concurrent idempotency, quota contention, idempotent replay after quota exhaustion, pausing due work and channel tests, and resuming with a single send.

Failure screenshots and traces are saved under ignored `test-results/`. GitHub CI runs `pnpm check:release` on pushes and pull requests without deployment secrets; failure artifacts are kept for seven days.

## Release

`pnpm run deploy` runs `pnpm check`, remote D1 initialization and Wrangler deployment. It does not run browser tests: complete `pnpm check:release` locally or in CI before releasing.

Production admin authentication should use [Cloudflare Access](../README.en.md#4-configure-admin-authentication-and-encryption). Before the first launch, verify login, actual provider delivery, scheduled messages, retries and statistics in the target Cloudflare environment. Passing local mock tests does not verify real providers.

## Project layout

```text
src/
  channels/   Provider adapters and HTTP error classification
  delivery/   Claims, retries, queue and direct dispatch
  domain/     Channels, groups, API keys, messages, templates and statistics
  routes/     Public API and admin entry points
  shared/     Shared types, templates and channel metadata
web/src/      React admin interface
migrations/   D1 initialization
test/        workerd unit tests
e2e/         Playwright browser and API tests
```

The backend uses Hono, Cloudflare Workers, Queues and D1. The admin frontend uses React, Kumo, TanStack Query and ECharts, built with Vite and the Cloudflare Vite plugin. See [architecture](design.en.md).
