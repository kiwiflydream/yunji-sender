# Integration guide

[简体中文](usage.md) · [English](usage.en.md)

[Back to README](../README.en.md)

## Channels, channel groups and API keys

A channel is a delivery target, such as a Feishu bot or a set of email recipients. A channel group gives several targets a stable name such as `ops-alert`. Calls to that group reach all enabled members. Duplicate targets within a request receive only one delivery.

Channel types and group slugs are immutable after creation. Group names and membership remain editable. Submission saves message content and target snapshots; later template or membership changes do not alter accepted content or targets.

Create a separate API key for each caller so it can be identified and revoked independently. A key restricted to channel groups may send only through an allowed `channelGroup`, never a nonempty `channels` list. The same rule applies after template expansion.

## HTTP API

Authenticate with a key created in the admin interface:

```text
Authorization: Bearer cfs_...
```

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/send` | Submit a custom or template message |
| GET | `/api/messages/:id` | Retrieve a message and its deliveries |
| POST | `/api/messages/:id/cancel` | Cancel deliveries that have not started |

Manage channels, groups, templates and keys in the admin UI. `/admin/api-docs` provides complete request and response examples.

### Custom messages

See the [README example](../README.en.md#send-your-first-message).

| Field | Description |
| --- | --- |
| `channelGroup` | Group slug; provide it or at least one `channels` target |
| `channels` | Channel IDs; may accompany a group, with duplicate targets removed |
| `title` / `body` | At least one nonempty; title ≤256 characters, body ≤16 KB UTF-8 |
| `format` | `text` (default) or `markdown`, converted per provider |
| `level` | `info` (default), `warn` or `error`; affects titles, colors and presentation |
| `url` / `tags` | Optional link and up to ten tags |
| `sendAt` | Epoch milliseconds or ISO 8601, up to 365 days ahead; omitted or past times mean now |
| `raw` | Per-provider request body, e.g. `{"feishu":{"msg_type":"text","content":{"text":"Notification"}}}` |

`raw` replaces generated content. Saved channel configuration still controls routing, credentials and signatures; callers cannot use it to add recipients. Bark and Email filter non-ASCII top-level field names; values still support Unicode and emoji.

KB means 1,024 bytes. The body is limited to 16 KB, serialized `raw` to 32 KB, and the complete JSON HTTP body, including escaping, to 256 KB. Total-size violations return 413; field-size violations return 422.

### Querying, cancellation and idempotency

New messages return `202 { messageId, deliveries: [...] }`. Delivery is asynchronous; successful submission does not mean every target has accepted it.

Use the variables from the README example and replace `MESSAGE_ID`:

```sh
curl "$SENDER_BASE_URL/api/messages/MESSAGE_ID" \
  -H "Authorization: Bearer $SENDER_API_KEY"

curl -X POST "$SENDER_BASE_URL/api/messages/MESSAGE_ID/cancel" \
  -H "Authorization: Bearer $SENDER_API_KEY"
```

Queries and cancellation require the exact API key that created the message. Messages owned by another key or created in the admin UI return 404. Cancellation affects only `scheduled` and `queued` deliveries, not in-flight or sent requests. The returned `canceled` count reflects this operation; repeating it may return zero.

`Idempotency-Key` is trimmed and must contain 1–255 characters. Use a stable unique key per business event. Reusing it with the same API key returns `200`, `duplicate: true` and the original message, even if content or templates changed. Different API keys have separate namespaces. After message retention removes the record, the key can create a new message.

Message states are `scheduled`, `pending`, `sent`, `partial`, `failed` and `canceled`. Each item in `deliveries` records its own state, attempts, upstream HTTP status, error and completion time. All response timestamps are milliseconds.

### Common errors

| Status | Meaning |
| --- | --- |
| 401 | Missing, invalid or revoked API key |
| 403 | The key cannot send to the requested targets |
| 404 | Message missing, removed or owned by another caller |
| 408 | Body read exceeded ten seconds; `error: request_timeout` |
| 413 | JSON HTTP body exceeds 256 KB; includes `maxBytes: 262144` |
| 422 | Invalid input, targets, template, variables or size; `issues` supplies field paths and reasons |
| 429 | `rate_limited` for ingress limits; `safety_limit` for quotas or backlog; respect `Retry-After` and reuse the idempotency key |
| 503 | `safety_limit, reason: paused` when paused; `temporarily_unavailable` when rate limiting is unavailable; respect `Retry-After` |
| 500 | Internal error; reuse the idempotency key when retrying |

These codes describe the API request. Inspect delivery results for provider rejections and network failures.

## Message templates

Configure content and default targets on Templates. On Send message → Use template, enter variables, preview and send, or call the API.

Five editable templates are seeded without recipients:

| ID | Purpose | Required variables |
| --- | --- | --- |
| `new-order` | New order | `orderNo` |
| `payment-success` | Payment confirmation | `orderNo`, `amount` |
| `order-shipped` | Shipping notification | `orderNo`, `carrier`, `trackingNo` |
| `deployment-result` | Deployment result | `service`, `environment`, `version`, `result` |
| `service-alert` | Service alert | `service`, `message`, `time` |

This request overrides the template's default targets with `ops-alert`:

```sh
curl "$SENDER_BASE_URL/api/send" \
  -H "Authorization: Bearer $SENDER_API_KEY" \
  -H 'Idempotency-Key: order-202610180001' \
  -H 'Content-Type: application/json' \
  -d '{
    "templateId": "new-order",
    "variables": { "orderNo": "202610180001" },
    "channelGroup": "ops-alert"
  }'
```

Use `{{variableName}}` in titles and bodies. Names start with an English letter and contain letters, digits and underscores. Values can be strings, numbers or booleans, not nested objects or expressions. Missing or blank values return 422; `0` and `false` are valid. Template IDs are immutable and `new` is reserved.

Supply at most 50 variables. Each string is limited to 16 KB, the serialized variable object to 32 KB, and the expanded body to 16 KB. Rendering is a single text substitution pass; it neither evaluates expressions nor recursively expands values.

Without explicit targets, template defaults apply. Supplying either `channels` or `channelGroup` replaces all defaults. Template requests support `sendAt` but cannot also include `title`, `body`, `format`, `level`, `url`, `tags` or `raw`; format and level come from the template.

Accepted messages retain rendered content and targets even if the template is changed or deleted. Retries and idempotent replays use the stored message.

## Worker Service Binding

Workers in the same Cloudflare account can call RPC without an API key. Merge this into the caller's `wrangler.jsonc`, replacing `service` with the deployed Sender name:

```json
{
  "services": [
    { "binding": "SENDER", "service": "yunji-sender", "entrypoint": "SenderRpc" }
  ]
}
```

```ts
const result = await env.SENDER.send(
  { channelGroup: 'ops-alert', title: 'Job failed', body: 'Data synchronization failed', level: 'error' },
  { idempotencyKey: 'sync-job-202610180001' },
)
```

`send()` also supports `templateId`, `variables` and `sendAt`. RPC does not use HTTP API key channel-group restrictions; grant bindings only to trusted callers. Shared delivery and execution budgets still apply.

## Channel configuration

Selecting a channel type shows its credentials and options. Credentials are encrypted and never returned as saved plaintext. Leaving them blank while editing retains their current value. Use Test before adding a target to a group.

To remove optional saved credentials, such as signing keys, Webhook headers or PushPlus recipients, choose Clear saved value and save. You can undo before saving; required credentials cannot be cleared. `PUT /admin/api/channels/:id` accepts `clearSecrets: ["fieldName"]`. Omitting a field or sending an empty string or `null` in `config` preserves it. Do not submit both a nonempty replacement and a clear request for the same field.

Telegram converts Markdown to HTML, Slack to mrkdwn and Email to HTML mail; Bark uses plain text and Feishu uses cards. Providers have their own limits and some adapters truncate content. Webhook sends normalized JSON and leaves rendering to the receiver.

### PushPlus

Enter a user or message Token; by default it sends to your own WeChat public-account subscription. Optional settings include PushPlus group code, channel, channel configuration code and explicit recipients. PushPlus groups are independent of Sender channel groups. SMS and voice use paid PushPlus services. Tokens and explicit recipients are encrypted.

Success means acceptance only; final-delivery callbacks are not implemented. Account restrictions and credential errors are recorded. Network errors, HTTP 429/5xx and PushPlus system errors retry; business code 900 indicates an account restriction and stops automatic retries.

### ServerChan

Enter a SendKey. The adapter recognizes Turbo `SCT...` and ServerChan³ `sctp{uid}t...` formats and stores the key encrypted. Configure recipients on the ServerChan platform. Bodies support Markdown; absent titles are derived from the body, flattened to one line and truncated to 32 UTF-16 units.
