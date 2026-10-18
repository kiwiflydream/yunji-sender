# Yunji Sender · 云吉 Sender

[简体中文](README.md) · [English](README.en.md)

A multi-channel notification gateway deployed on Cloudflare.

Send order updates, deployment results and service alerts through one API. Manage recipients, templates and retries in the admin UI without integrating every notification provider into each application or running a dedicated server.

[Quick deployment](#quick-deployment) · [Send your first message](#send-your-first-message) · [Integration guide](docs/usage.en.md) · [Local development](docs/development.en.md)

> **Use Cloudflare Access for admin login and access authorization in production.** Restrict access through identity policies and set `ADMIN_AUTH_MODE` to `access`. The default Basic authentication is a convenient option for local development or quick trials. Access protects the admin interface; the business API continues to use separate API keys.

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

**Cloudflare Access is the recommended production login and authorization method.** Create a Self-hosted application in Cloudflare Zero Trust covering `/admin` and `/admin/*` on the hostname users will visit. Allow only the intended email addresses, groups or identity-provider identities. Verify coverage of both the admin root and all subpaths, including `/admin/api/*`.

Set these values in the `vars` section of `wrangler.jsonc`:

```json
{
  "ADMIN_AUTH_MODE": "access",
  "ACCESS_TEAM_DOMAIN": "your-team.cloudflareaccess.com",
  "ACCESS_AUD": "your-application-audience-tag"
}
```

Use the team hostname without `https://` or a path, and the audience tag of this Access application. The Worker verifies the Access JWT signature, issuer and audience. Missing configuration or invalid tokens deny access; Access mode never falls back to Basic. Access policies determine who can enter the admin interface. All admitted users have administrative permissions; the application does not provide additional role levels.

Keep the business `/api/*` outside an admin Access application requiring interactive login: these requests use Sender API keys. Check every exposed entry point, including custom domains, `workers.dev` and preview URLs. See the [official Access setup guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/).

Every authentication mode needs an encryption key for channel credentials:

```sh
pnpm exec wrangler secret put ENCRYPTION_KEY
```

Enter a key generated with `openssl rand -base64 32` and back it up securely. Losing or replacing it makes existing channel credentials unreadable. If the first secret command offers to create the Worker, confirm creation and continue.

For local development or a quick trial, keep the default `ADMIN_AUTH_MODE: "basic"` and set a separate strong password. The default username is `admin`:

```sh
pnpm exec wrangler secret put ADMIN_PASSWORD
```

Access mode does not require `ADMIN_PASSWORD`. Create message-sending API keys in the admin UI; they are not deployment secrets.

### 5. Deploy and open the admin interface

```sh
pnpm run deploy
```

This runs type checks, unit tests and the build, initializes D1, then deploys the Worker. Open `/admin` on the returned URL and authenticate through Access. In Basic mode, use `admin` and your `ADMIN_PASSWORD`.

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

## Documentation

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
