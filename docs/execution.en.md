# Execution and runtime settings

[简体中文](execution.md) · [English](execution.en.md)

[Back to README](../README.en.md)

## Queue and direct delivery

Select the execution mode under Settings. Queue mode is the default.

| Mode | Immediate messages | Scheduling and retries | Suitable use |
| --- | --- | --- | --- |
| `queue` | Enqueue each target for the consumer | Delayed queue within 12 hours; Cron enqueues more distant work when it enters that window | Multiple targets, sustained traffic or finer retry intervals |
| `direct` | Send in the request background, up to four targets | Remaining work and retries are handled by minute Cron, up to four due targets per run | Lower volume without Queues |

Waiting work does not spend an attempt, but backlogs add latency. `sendAt` is a planned time, not an exact arrival guarantee.

To omit Queues, remove the entire `queues` section from `wrangler.jsonc`, run `pnpm cf-typegen`, deploy and select Direct in Settings. Queue mode without a binding falls back to direct mode with a warning. Failed enqueues return to Cron with backoff.

## Retries and recovery

Targets execute independently. Network errors, the 10-second request timeout, HTTP 408, 429 and 5xx can retry; other HTTP and business errors are classified by the adapter.

Backoff is 10 seconds, 30 seconds, 2 minutes, 10 minutes, 30 minutes and then 1 hour. Valid `Retry-After` or provider retry hints take precedence, clamped to 1 second–1 hour. Direct retries wait for minute Cron, so actual intervals may be longer.

Cron recovers deliveries that never started or lost their execution lease. Claims compare delivery ID and attempt count so duplicate queue messages cannot execute the same attempt twice. A provider may accept a request before the local result is lost, so later attempts can still repeat the external request. Webhook receivers can deduplicate on `X-Sender-Delivery`.

Enqueue waits are capped at 10 seconds. A timeout leaves the result unknown, so the persisted reservation remains. Each delivery allows at most 12 dispatches; enqueue failures back off by 1, 2, 4, 8, 16, 32 and then 60 minutes. Unconsumed queue messages receive a 15-minute recovery window measured from the later of their planned attempt and last dispatch, avoiding immediate redispatch.

Deliveries expire 24 hours after their scheduled send time. Cron fails pending work whose deadline or dispatch allowance is exhausted. Actual sends also obey the maximum attempt setting. Manual retry resets dispatch count and the 24-hour deadline, checks backlog capacity first, and still uses the shared execution budget.

## Cost protection

Settings → Cost protection counts target deliveries: a message addressed to three channels uses three admission units.

| Setting | Default | Purpose |
| --- | --- | --- |
| Pause all sending | Off | Reject new messages, block queue/direct sends and channel tests; requests already in flight cannot be recalled |
| Daily global delivery limit | 1,000 | New target deliveries across all entry points |
| Daily limit per caller | 500 | Separate per API key; admin and RPC each use a shared caller scope |
| Per-minute limit per caller | 100 | New targets within each calendar minute |
| Maximum pending deliveries | 1,000 | Future schedules, queued work and in-flight work |
| Daily work budget | 3,000 | One unit for each enqueue and actual send; retries, Cron recovery and channel tests share it |

Daily quotas reset at midnight UTC. D1 reserves quotas and updates business state in the same transaction, preventing concurrent requests from exceeding the configured limit. Rejected new messages leave no partial records or quota charges; idempotent replays do not charge again. Enqueue batches reserve as a whole: insufficient remaining budget defers the entire batch rather than splitting it.

Admission limits return `429`; a pause returns `503`. The response contains `{ "error": "safety_limit", "reason": "..." }` and `Retry-After`. Accepted deliveries wait until the next UTC day when the work budget is exhausted, or until sending resumes after a pause, but still fail if their own deadline expires. Respect `Retry-After` and reuse idempotency keys.

The repository caps queue consumer concurrency at two and Worker CPU at 1,000 ms, subject to platform plan limits. These controls bound application-generated deliveries and retries, not total monetary cost: inbound requests, maintenance, database operations, queue redelivery and storage can still incur charges.

The complete schema, indexes and safety triggers are in `migrations/0001_init.sql`. `pnpm deploy` initializes D1 before deploying code.

## Settings and retention

Runtime settings are stored in D1 and take effect without redeployment.

| Setting | Default | Allowed range |
| --- | --- | --- |
| Execution mode | Queue | Queue or direct |
| Maximum attempts | 5 | 1–10, including the first attempt |
| Message retention | 30 days | 1–3,650 days |
| Statistics retention | 90 days | 1–3,650 days |

Hourly cleanup removes messages older than retention only after every delivery finishes. Future or unfinished messages remain; deleting a message cascades to its deliveries and expires its idempotency key. Statistics have independent retention. Increasing retention cannot restore removed data.

Statistics include successful and failed deliveries, retries and latency. Supported ranges are 24 hours, 7 days, 30 days and 90 days; longer ranges group by calendar day in the viewer's timezone.

## Admin authentication and language

**Use Cloudflare Access for production admin login and access authorization.** Restrict admitted identities with Access policies. All admitted users have admin permissions; no additional application roles exist. See the [README setup](../README.en.md#4-configure-admin-authentication-and-encryption).

Basic is the default convenience option for local development or quick trials. Its username comes from `ADMIN_USERNAME` in `wrangler.jsonc` (default `admin`) and its password from the `ADMIN_PASSWORD` secret.

For Access, create a Self-hosted application protecting `/admin` and its children, configure an allow policy and set:

| Variable | Value |
| --- | --- |
| `ADMIN_AUTH_MODE` | `access` |
| `ACCESS_TEAM_DOMAIN` | Team hostname, for example `myteam.cloudflareaccess.com` |
| `ACCESS_AUD` | This application's audience tag |

Use the hostname without a scheme or path. Access mode needs no `ADMIN_PASSWORD` and never falls back to Basic on failure. Verify `/admin`, `/admin/*` and every other exposed hostname entry point.

Fetching Access public keys, including the body, is limited to five seconds. Concurrent authentication shares a fetch; failures and unknown signatures cannot trigger another refresh within 60 seconds. This limits authentication failure storms.

Redeploy after changing these variables. `/api/*` uses API keys; keep interactive admin Access policies off business API calls.

The UI initially follows the browser language: Simplified Chinese or English, with other languages falling back to English. Change it using the language button or Settings → Interface language; the choice is stored in the browser. Switching preserves unsaved form input and does not translate saved channel names, messages or template text.

## Cloudflare usage and costs

Queues supports Workers Free and Paid. See [official Queue pricing](https://developers.cloudflare.com/queues/platform/pricing/) for current allowances and retention. A normal queue delivery typically requires writing, reading and deleting a message; each target is enqueued separately, and fan-out, retries and dead letters add operations.

Worker requests, CPU, D1 reads/writes and storage have separate allowances and billing. Admin queries, maintenance and statistics also consume resources. Monitor actual usage and tune volumes and retention. Refer to [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

## Ingress and statistics protection

Three native Rate Limiting bindings in `wrangler.jsonc` protect the expensive paths. Before authentication or D1 reads, each IP gets 300 requests per minute per entry class (`api` or `admin`), and each class gets 1,000 total per minute. Authenticated statistics reads have another shared 30-per-minute limit. Users behind the same public IP share a bucket; absent Cloudflare IP headers use an `unknown` bucket. Client-supplied X-Forwarded-For and random credentials do not determine bucket identity. Assign independent `namespace_id` values to separate deployments in the same account.

Excess traffic gets `429 rate_limited` with `Retry-After: 60` without D1 access. Missing, failing or stalled bindings return `503 temporarily_unavailable` after at most one second instead of permitting unlimited traffic. Malformed API keys are rejected without querying D1.

Statistics are cached for 60 seconds by database, range and canonical timezone. Within one Worker isolate, concurrent identical requests share one aggregation. The cache holds at most 16 entries and four distinct in-flight aggregations; oversized results are not retained. Query waits are capped at 10 seconds and failures are not cached. Statistics and channel names may lag by roughly 60 seconds. Authentication remains mandatory and HTTP responses use `no-store`.

Native limits are per Cloudflare location and eventually consistent; the cache is isolate-local. Neither is a precise global quota or monetary cap. Global delivery budgets remain transactional in D1. See [Rate Limiting documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

These bindings reduce D1 traffic but do not eliminate charges for requests that reach a Worker. On a production custom domain, configure suitable edge protection for `/api/*` and `/admin*`, and check other public endpoints for bypasses. This repository does not configure live WAF rules.
