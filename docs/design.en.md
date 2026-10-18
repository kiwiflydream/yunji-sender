# Yunji Sender architecture

[简体中文](design.md) · [English](design.en.md)

[Back to README](../README.en.md)

## Models

- **Channel:** a target such as a Feishu bot, Telegram chat or set of email recipients. `src/shared/catalog.ts` drives forms and server validation. Secret fields are encrypted together with AES-GCM, with AAD bound to the channel ID, and never returned as saved plaintext. Blank edits preserve existing secrets. The type is immutable.
- **Channel group:** a named set of channels. Callers use its stable slug; admins edit membership. Slugs are immutable to preserve template and API key references, while names and bindings remain editable.
- **API key:** begins with `cfs_`; only SHA-256 is stored. Optional group restrictions prevent direct channel targeting. `last_used_at` is refreshed at minute resolution.
- **Message:** one submission with normalized content and `send_at`.
- **Delivery:** one message × channel, with independent state, attempts and outcome. Channel names and group slugs are snapshots so history survives deletion.

## Templates

`message_templates` stores stable IDs, names, descriptions, title/body, format, level and default targets. `0001_init.sql` seeds five editable templates for orders, payments, shipping, deployments and alerts without recipients. CRUD is restricted to authenticated `/admin/api/templates` routes.

API, admin and RPC share `sendMessage`: expand `templateId + variables`, then validate content, targets and API key permissions. Explicit `channelGroup` or `channels` replaces all default targets. Template calls cannot include manual content fields.

`src/shared/templates.ts` is shared by server rendering and UI previews. It reads own properties only and performs a single flat substitution pass, without expression evaluation or recursive parsing. Missing or blank values are errors; zero and false are valid.

At most 50 variables and 32 KB of serialized variables are accepted. Expansion size is computed before allocation to enforce 256-character titles and 16 KB bodies. Templates may use at most 50 distinct variables.

Rendered content is saved in `messages.payload`; retries do not depend on the template still existing. Idempotency checks happen before expansion, so changes or deletion cannot break an accepted request's replay. Admin template pages use the existing Kumo forms and tables, showing IDs, variables, targets and text previews; actual provider formatting remains the adapter's responsibility.

## Delivery state machine

```text
scheduled ──cron──> queued ──claim──> sending ──> sent
    ^                 ^                 |
    |                 +── retry(queue) ─+
    +── retry(direct) / recovery ────────+
                                        +──> failed
scheduled / queued ──cancel──> canceled
failed / canceled ──manual retry──> queued
```

`attempts` counts attempts that started. Claims compare expected attempts and pending status; queue messages carry that expected count. Duplicate messages and recovered work cannot run the same attempt twice. Results also compare `status = 'sending' AND attempts = ?`, discarding late outcomes after a lease was recovered.

Final statistics are inserted before the closing update in the same D1 batch with the same ownership condition. Each final outcome counts once. Manually retrying failed work first withdraws its previous failure statistics.

## Execution modes

Queue availability and runtime configuration determine execution mode, not the account's plan. See [official Queue pricing](https://developers.cloudflare.com/queues/platform/pricing/) for current plan allowances.

| Behavior | `queue` (default) | `direct` |
| --- | --- | --- |
| Due work | `sendBatch`, then consumer | Request `waitUntil` |
| Retry | New delayed queue message | `scheduled`, then minute Cron |
| Schedule within 12 hours | Delayed queue | Cron |
| Schedule beyond 12 hours | Cron enqueues within the 12-hour window | Cron |

Without `DELIVERY_QUEUE`, queue mode falls back to direct with a warning. Enqueue failure or an unconfirmed 10-second wait returns work to `scheduled`, retaining dispatch count and backoff for Cron recovery.

## Minute Cron

1. Fail pending work that passed `deadline_at` or exhausted 12 dispatches, up to 20 rows per run.
2. When not paused, dispatch scheduled work whose planned time is within the execution horizon and whose `dispatch_after` has passed. Queue mode first changes state using compare-and-swap, then atomically reserves dispatch count and work budget before enqueueing.
3. Recover queued work still unstarted 15 minutes after the later of planned attempt and last dispatch, up to 20 rows.
4. Treat expired 60-second sending leases as retryable failures, up to two rows.
5. Hourly, purge finished expired messages, statistics and quota counters older than two days. Cleanup still runs while paused.

State-specific partial indexes match scheduled, queued and sending predicates. Regression tests check both query counts and actual `rows_read`. Queue dispatch handles at most 20 items per run; direct handles four, so backlogs drain over multiple runs.

Admission quotas are reserved by message insertion triggers in `usage_counters`. Dispatch/attempt triggers reserve execution budget; channel tests share that budget. Quota changes and business state commit together. `safety:*` errors roll back rejected admissions; accepted work waits for budget recovery or expiry. See [cost protection](execution.en.md#cost-protection).

## Retries and errors

`src/channels/http.ts` classifies network failures, 10-second timeouts, HTTP 408, 429 and 5xx as retryable. Other 4xx normally stop. Provider-specific retryable codes include Feishu 9499/11232, WeCom 45009, DingTalk 130101, Telegram 429 and PushPlus 500. PushPlus 900 indicates account restriction and stops requests. Nonzero ServerChan business codes do not automatically retry; other business errors normally stop too.

Backoff is 10 seconds, 30 seconds, 2 minutes, 10 minutes, 30 minutes and then 1 hour. `maxAttempts` defaults to five. `Retry-After` and supported provider hints take precedence, clamped to 1 second–1 hour. Admission has separate global, caller and backlog limits, while all execution shares a daily work budget. There is no extra rate shaping per upstream channel.

Channel secrets are redacted from errors and responses before persistence, including tokens embedded in URLs.

## Provider rendering

Adapters transform `{title, body, format, level, url, tags, raw}`:

| Provider | Markdown handling | Notes |
| --- | --- | --- |
| Webhook | Unchanged | Normalized JSON, optional `X-Sender-Signature: sha256=HMAC(secret, "ts.body")`; `X-Sender-Delivery` supports deduplication |
| Telegram | HTML | Falls back to truncated plain text above 4,096 characters to avoid broken tags; configurable API base |
| Feishu | Card Markdown | Level-colored header; plain text for text mode; optional signing |
| WeCom | Unchanged | Truncates Markdown at 4,096 bytes and text at 2,048 bytes |
| DingTalk | Unchanged | Optional signing; configured keywords must appear in the message |
| Slack | mrkdwn | Header and section blocks |
| Discord | Unchanged | Level-colored embeds; generated payloads disable mentions |
| Bark | Plain text | Warn/error maps to timeSensitive |
| PushPlus | Unchanged | Markdown/txt templates; saved credentials and recipients; 200 means acceptance only |
| ServerChan | Unchanged | Endpoint from SCT/sctp key; single-line title ≤32 UTF-16 units; platform-configured recipients |
| Email | HTML | Resend; delivery ID used as idempotency key within the provider's deduplication window |

`raw[type]` replaces generated content while saved routing, credentials and signing remain authoritative. Bark removes `device_key` and `device_keys`; Email removes `from`, `to`, `cc`, `bcc` and `reply_to`, case-insensitively, then restores saved routing. Both filter non-ASCII top-level keys to avoid differing Unicode case-folding behavior. ServerChan derives the endpoint from its SendKey and removes `channel` and `openid`; Telegram and PushPlus also restore saved routing fields.

HTTP redirects are not followed, preventing credential forwarding and additional requests; configure final URLs. Protocol-aware adapters require explicit success codes or message IDs; Slack requires `ok`. Missing acknowledgments on 2xx are retryable failures. Generic Webhook uses HTTP status. Diagnostics redact individual headers, URL credentials and encoded values, then retain at most 2 KB.

Execution is bounded: direct dispatch handles four targets and schedules overflow without spending attempts; Cron handles four direct or 20 queue targets plus two expired leases. Hourly cleanup handles at most five batches of 500 messages. Queue batches contain at most five messages. Fan-out and group bindings use JSON bulk inserts rather than one SQL statement per target.

## Message lists

Stable ordering uses `(created_at DESC, id DESC)`. `nextBefore` contains both timestamp and ID; pass it unchanged as `before`. Timestamp-only cursors are rejected. One extra row determines whether another page exists.

Queries select the current page by cursor, group and state before aggregating its deliveries. Transactionally maintained `delivery_state` and combined cursor indexes avoid aggregating completed history. Separate indexes serve group-filtered state queries.

The admin first page refreshes every five seconds while work is pending, otherwise every 30 seconds. Multiple loaded pages lengthen the interval to reduce repeated history reads. Send, cancel and retry invalidate relevant client caches.

## Statistics

`delivery_stats` accumulates final outcomes by planned-send minute, channel and group: success, failure, retries and latency from `send_at` to completion. The 24h/7d ranges group hourly; 30d/90d group by the viewer's local calendar day. Minute precision supports fractional-hour zones. Local-day boundaries use the first real instant of the date, including skipped or repeated midnight due to daylight saving changes.

D1 aggregates into display buckets before returning data to the Worker. Manual retries withdraw the old failure from the same minute bucket. Message cleanup does not remove statistics still within their independent retention period.

Authenticated statistics reads also use a shared native rate limit and a bounded 60-second isolate-local cache. See [ingress and statistics protection](execution.en.md#ingress-and-statistics-protection) for limits and freshness.

## D1 queries and indexes

Check query plans and actual rows read together. `LIMIT` bounds returned rows, not necessarily scanned rows; `SCAN ... USING INDEX` may still traverse an entire index.

| Query | Index strategy |
| --- | --- |
| Due schedules, lost queues, leases | Exact state-specific partial indexes; expression index for queue recovery time |
| Expiry and exhausted dispatches | Disjoint `UNION ALL` branches over deadline ranges and the exhausted-work partial index, with an overall limit |
| Quota cleanup | `usage_counters(bucket)` range index |
| Message pagination | Four combined cursor indexes: general, group, state, group plus state |
| Details, delivery joins, cascade deletion | Message primary key, `deliveries(message_id)`, group association primary key and reverse channel index |
| Statistics windows and cleanup | `bucket` prefix of the composite statistics primary key |
| API key authentication and individual settings/templates | Unique or primary-key lookups |

Complete configuration lists and channel-name maps intentionally return all rows; their sequential scans are not missing-filter-index bugs. Five incremental counters and a stored generated column maintain message state. Delivery insert, status-change and delete triggers commit or roll back with their parent operation. Lower read costs trade off against parent counter updates and index maintenance on writes.

Manual retry atomically checks backlog capacity when reopening terminal work. Rejection rolls back state, deadline and withdrawn failure statistics; concurrent retries cannot exceed capacity. The `idx_deliveries_exhausted` threshold must match `MAX_DISPATCHES`.

Regression tests include 1,000 unrelated historical/future deliveries, 1,000 current quota counters, idle maintenance read counts, concurrent retries and full-capacity rollback.

`delivery_state` excludes wall-clock time: if all pending deliveries are scheduled, it stores `scheduled`. Queries use `send_at > now` to distinguish future schedules from due pending work without database writes or waiting for Cron. State queries explicitly choose the matching cursor index to prevent SQLite from preferring a group time index and scanning completed history. Pending queries inspect only the two active state buckets. Current-page display counts still aggregate actual deliveries for consistency. Cancellation and Cron recovery count `RETURNING` rows so trigger writes do not inflate `meta.changes`.
