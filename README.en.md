# Yunji Sender · 云吉 Sender

[简体中文](README.md) · [English](README.en.md)

A multi-channel notification gateway deployed on Cloudflare.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kiwiflydream/yunji-sender)

Send order updates, deployment results and service alerts through one API. Manage recipients, templates and retries in the admin UI without integrating every notification provider into each application or running a dedicated server.

[Quick deployment](#quick-deployment) · [Configuration reference](#configuration-reference) · [Send your first message](#send-your-first-message) · [Integration guide](docs/usage.en.md) · [Local development](docs/development.en.md)

> **Basic authentication is the default for quick deployment.** Set an admin password to get started; Cloudflare Access can be configured later.

## Features

- **Multiple channels:** send to several targets through one request, with independent results and retries.
- **Channel groups:** give recipients a stable identifier such as `ops-alert`; change group membership without changing callers.
- **Templates:** editable order, payment, shipping, deployment and alert templates, plus custom templates.
- **Scheduling and idempotency:** schedule messages, cancel work that has not started and avoid duplicate submissions.
- **Delivery history and statistics:** inspect status, attempts, errors and latency by channel or group.
- **Credentials and permissions:** encrypted channel credentials, API keys restricted to channel groups and Service Binding calls from Workers in the same account.
- **Cost protection:** daily delivery and caller quotas, backlog caps, a shared execution budget and a sending pause; ingress limits, bounded retries and timeouts reduce abnormal consumption.
- **Admin interface:** Simplified Chinese and English, desktop and mobile layouts, and API examples that use your deployment URL.

## Supported channels

| Category | Channels |
| --- | --- |
| Chat and collaboration | Telegram, Feishu / Lark, WeCom, DingTalk, Slack, Discord |
| Mobile and WeChat push | Bark, PushPlus, ServerChan |
| Email | Email through Resend |
| Custom integration | Webhook with custom headers and optional HMAC signing |

Messages support text and Markdown, converted or downgraded for each provider. See the [integration guide](docs/usage.en.md) for configuration and limits.

## Quick deployment

You need a Cloudflare account, Node.js 22.12 or newer and pnpm 10.34.4. Run the following from the project directory. The pnpm version is pinned in `package.json`.

### 1. Install dependencies and sign in

```sh
pnpm install
pnpm exec wrangler login
```

### 2. Create the database

```sh
pnpm exec wrangler d1 create yunji-sender
```

Replace the all-zero `database_id` in [wrangler.jsonc](wrangler.jsonc) with the returned ID.

### 3. Create queues

The default mode uses Cloudflare Queues. Create both the delivery queue and its dead-letter queue:

```sh
pnpm exec wrangler queues create yunji-sender-deliveries
pnpm exec wrangler queues create yunji-sender-deliveries-dlq
```

For direct delivery only, remove the entire `queues` section from `wrangler.jsonc`, run `pnpm cf-typegen` and skip queue creation. See [execution modes](docs/execution.en.md).

### 4. Configure admin authentication and encryption

Basic authentication is the default. Keep `ADMIN_AUTH_MODE=basic` and `ADMIN_USERNAME=admin`. The deployment wizard only needs two values: a strong admin password and an encryption key generated with `openssl rand -base64 32`.

```sh
pnpm exec wrangler secret put ADMIN_PASSWORD
pnpm exec wrangler secret put ENCRYPTION_KEY
```

Back up the encryption key: losing or replacing it makes existing channel credentials unreadable. Create message-sending API keys in the admin UI after deployment.

<details>
<summary>Optional: switch to Cloudflare Access</summary>

**Cloudflare Access is available as an optional login method.** Create a Self-hosted application in Cloudflare Zero Trust covering `/admin` and `/admin/*` on the hostname users will visit. Allow only the intended email addresses, groups or identity-provider identities. Verify coverage of both the admin root and all subpaths, including `/admin/api/*`.

Add or update these values in the `vars` section of `wrangler.jsonc`:

```json
{
  "ADMIN_AUTH_MODE": "access",
  "ACCESS_TEAM_DOMAIN": "your-team.cloudflareaccess.com",
  "ACCESS_AUD": "your-application-audience-tag"
}
```

Use the team hostname without `https://` or a path, and the audience tag of this Access application. The Worker verifies the Access JWT signature, issuer and audience. Missing configuration or invalid tokens deny access; Access mode never falls back to Basic. Access policies determine who can enter the admin interface. All admitted users have administrative permissions; the application does not provide additional role levels.

Keep the business `/api/*` outside an admin Access application requiring interactive login: these requests use Sender API keys. Check every exposed entry point, including custom domains, `workers.dev` and preview URLs. See the [official Access setup guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/).

Access mode does not use `ADMIN_PASSWORD`.

</details>

### 5. Deploy and open the admin interface

```sh
pnpm run deploy
```

This runs type checks, unit tests and the build, initializes D1, then deploys the Worker. Open `/admin` on the returned URL and log in with `admin` and your `ADMIN_PASSWORD`. If you later switch to Access, follow its login flow.

Run `pnpm check:release` for the complete pre-release checks, including browsers. See [local development](docs/development.en.md) for browser installation and coverage.

## Send your first message

1. Add and test a target on the Channels page.
2. Create the `ops-alert` channel group and add the target.
3. Create an API key allowed to send to `ops-alert`; save the full token when shown.
4. Replace the URL and API key below and send a message.

```sh
export SENDER_BASE_URL="https://your-worker.workers.dev"
export SENDER_API_KEY="cfs_replace_with_your_key"

curl "$SENDER_BASE_URL/api/send" \
  -H "Authorization: Bearer $SENDER_API_KEY" \
  -H 'Idempotency-Key: readme-first-message-1' \
  -H 'Content-Type: application/json' \
  -d '{
    "channelGroup": "ops-alert",
    "title": "First notification",
    "body": "Yunji Sender is connected",
    "level": "info"
  }'
```

The first submission returns `202` and a `messageId`, meaning it was accepted. Reuse the same key for retries of the same event; use a new idempotency key for a new event. Inspect results in the admin UI or with `GET /api/messages/:id`.

## Configuration reference

For the first deployment, supply only `ADMIN_PASSWORD` and `ENCRYPTION_KEY`. Keep the default login mode and username. Add optional integrations later.

### Environment variables and secrets

Set ordinary variables in `wrangler.jsonc` under `vars` and redeploy. Set secrets with `pnpm exec wrangler secret put NAME`. You can also use the Worker's Variables and Secrets dashboard; keep ordinary variables synchronized with the repository so subsequent deployments do not overwrite them. Use the ignored `.dev.vars` file locally and never commit secrets.

| Setting | Type | Default / requirement | Purpose |
| --- | --- | --- | --- |
| `ADMIN_AUTH_MODE` | Variable | `basic`; optional | Admin login method: `basic` or `access` |
| `ADMIN_USERNAME` | Variable | `admin`; optional | Basic username; unused in Access mode |
| `ADMIN_PASSWORD` | Secret | No default; required for Basic | Admin password; unused in Access mode |
| `ENCRYPTION_KEY` | Secret | No default; supply during deployment | Encrypts channel credentials; generate with `openssl rand -base64 32`. Losing or replacing it makes old credentials unreadable |
| `ACCESS_TEAM_DOMAIN` | Variable | Unset; required for Access | Team hostname such as `myteam.cloudflareaccess.com`, without a scheme or path |
| `ACCESS_AUD` | Variable | Unset; required for Access | Audience tag of the admin Access application; create the application and access policy separately in Zero Trust |

Sender has no `API_TOKEN` environment variable. Create sending API keys in the admin UI. Configure provider tokens, webhook URLs and recipients on the Channels page; see [channel configuration](docs/usage.en.md).

### Runtime settings

Save these on the Settings page. They are stored in D1 and apply without redeployment. They are not environment variables and should not be added to `vars`.

| Field | Default | Purpose / range |
| --- | --- | --- |
| `executionMode` | `queue` | `queue` or `direct`; falls back to direct delivery without a queue binding |
| `maxAttempts` | `5` | Maximum attempts including the first, 1–10 |
| `retentionDays` | `30` | Message and delivery retention in days, 1–3650 |
| `statsRetentionDays` | `90` | Aggregated statistics retention in days, 1–3650 |
| `sendingPaused` | `false` | Pauses new message admission, dispatch and channel tests; cannot recall requests already sent |
| `dailyDeliveryLimit` | `1000` | Daily admission limit measured in channel targets, 1–1000000 |
| `perKeyDailyDeliveryLimit` | `500` | Daily delivery limit per caller, 1–1000000 |
| `perKeyMinuteLimit` | `100` | Delivery limit per caller per minute, 1–100000 |
| `maxPendingDeliveries` | `1000` | Total scheduled, queued and sending deliveries, 1–100000 |
| `dailyWorkLimit` | `3000` | Daily work budget, 1–3000000; each enqueue or actual send costs one unit, including retries and channel tests |

Daily quotas reset at UTC midnight; minute quotas use UTC calendar minutes. Each API key has its own caller quota; admin and RPC traffic each share a separate caller bucket. See [execution and costs](docs/execution.en.md).

### Cloudflare resources and deployment settings

These live in `wrangler.jsonc`. Code relies on the binding names; normally retain the template defaults. Run `pnpm cf-typegen` after changing bindings, then redeploy.

| Setting / binding | Purpose and default behavior |
| --- | --- |
| `name` | Worker name; defaults to `yunji-sender` |
| `DB` / `d1_databases` | Required D1 database for channels, messages, API keys, templates and quotas. Supply a real `database_id` for CLI deployment; the deployment wizard provisions and fills it in |
| `DELIVERY_QUEUE` / `queues` | Optional queue included in the template: batch size 5, wait 1 second, 3 retries, concurrency 2, plus a dead-letter queue. Remove the entire section to use direct delivery |
| `INBOUND_RATE_LIMIT` | Required ingress limiter: 300 requests/60 seconds per IP and ingress category |
| `INBOUND_TOTAL_LIMIT` | Required shared ingress limiter: 1000 requests/60 seconds per ingress category |
| `STATS_RATE_LIMIT` | Required statistics limiter: shared 30 requests/60 seconds |
| `ratelimits[].namespace_id` | Native rate-limit namespace; assign distinct IDs to independent instances within one account to avoid shared quotas |
| `limits.cpu_ms` | CPU time per invocation, default 1000 ms; not total request wall time |
| `ASSETS` / `assets` | Admin static assets and routing; preserve Worker-first authentication for `/admin` and `/admin/*` |
| `triggers.crons` | `* * * * *`: handles due deliveries, retries, recovery and cleanup every minute |
| `observability.enabled` | `true`: enables Worker observability logs |
| `main`, `compatibility_date` | Worker entry point and compatibility date; usually unchanged |

Native rate limits are not globally exact billing caps. Missing limiter bindings reject the affected requests. D1 maintains business daily budgets; see [execution and ingress protection](docs/execution.en.md). To call Sender through RPC, configure a `services` binding in the **calling project**, targeting this Worker and its `SenderRpc` entrypoint; see [integration examples](docs/usage.en.md).

### Business settings and browser preferences

- **Channels:** provider, credentials, recipients, enabled state and timeout; see [provider-specific fields](docs/usage.en.md).
- **Channel groups:** combine channels into a sending target, selected with `channelGroup`.
- **API keys:** create caller credentials, permissions and allowed channel groups in the UI; revoke when needed. These are not deployment secrets.
- **Templates:** save titles, bodies, formats and variable definitions. Supply a template and variables when sending; see [scheduling, idempotency and cancellation](docs/usage.en.md).
- **Language / appearance:** choose Chinese or English and System, Light or Dark on the Settings page. Preferences are saved in this browser only.

## Documentation

Choose System, Light or Dark under **Settings › Appearance**. System is the default. Changes apply immediately, are saved in this browser, and update chart colors too.

Under **Settings › About**, view the deployed version and click **Check for updates** to compare it with the latest stable GitHub Release. The panel links to release notes, source code and the author's X profile. Checks run only when clicked, time out after 8 seconds, never retry automatically, and cache successful results for one minute. The service is not upgraded automatically.

- [Integration guide](docs/usage.en.md): HTTP API, templates, Service Bindings, channel configuration and errors.
- [Execution and settings](docs/execution.en.md): queues, direct delivery, scheduling, retries, retention, authentication and costs.
- [Development and verification](docs/development.en.md): local setup, tests, release checks and project layout.
- [Architecture](docs/design.en.md): models, state transitions, recovery, adapters and statistics.

The deployed `/admin/api-docs` page includes complete HTTP examples using your deployment address.

## Cost protection and ingress limits

Settings → Cost protection updates take effect without redeployment. Defaults are 1,000 accepted target deliveries per day globally, 500 per caller per day, 100 per caller per minute, 1,000 pending deliveries and 3,000 execution units per day. Sending can be paused. Each enqueue and actual send consumes one execution unit; retries, recovery and channel tests share the budget. Daily quotas reset at midnight UTC.

Ingress limits run before authentication and D1 reads. Configure `ratelimits` in `wrangler.jsonc`: 300 requests per IP per entry class per minute, 1,000 total per entry class per minute, and a separate 30-per-minute statistics limit. Redeploy after changes. Give separate deployments in the same account distinct `namespace_id` values. Statistics are cached for 60 seconds and may lag behind delivery changes.

These controls are not a monetary hard cap. Native rate limits are per Cloudflare location; Worker requests, storage and external providers may still incur costs. Configure appropriate edge protection and monitor usage. See [execution and settings](docs/execution.en.md) for full limits, timeouts and retries.

## Operational boundaries

A successful delivery means the provider accepted the request; final receipt depends on the provider. Scheduled times are not exact arrival guarantees: queues, platform scheduling and retries may delay delivery.

History is removed according to retention settings. Its idempotency keys cease to prevent new messages after removal. Webhook receivers should also deduplicate using the delivery identifier.

## License

This project is licensed under the [MIT License](LICENSE).
