-- Delivery targets. Non-secret fields live in `config` (JSON); credentials
-- (tokens, webhook URLs with keys, signing secrets) are AES-GCM encrypted in
-- `secrets_encrypted`, bound to the channel id.
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}',
  secrets_encrypted TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE channel_groups (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE channel_group_channels (
  channel_group_id TEXT NOT NULL REFERENCES channel_groups(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_group_id, channel_id)
) WITHOUT ROWID;
CREATE INDEX idx_channel_group_channels_channel ON channel_group_channels (channel_id);

-- Only the SHA-256 of a key is stored; `prefix` identifies it in the UI.
-- `channel_groups` is a JSON array of allowed channelGroup slugs, NULL for unrestricted keys.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  channel_groups TEXT,
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

-- One accepted send request. `channel_group_slug` is a snapshot so logs survive channelGroup
-- deletion. `idem` is "<scope>:<Idempotency-Key>" where scope is the API key
-- id, "rpc" or "admin".
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  channel_group_slug TEXT,
  source TEXT NOT NULL CHECK (source IN ('api', 'rpc', 'admin')),
  api_key_id TEXT,
  idem TEXT,
  payload TEXT NOT NULL,
  send_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE UNIQUE INDEX idx_messages_idem ON messages (idem) WHERE idem IS NOT NULL;
CREATE INDEX idx_messages_created ON messages (created_at DESC);

-- One message to one channel. Status machine:
--   scheduled  waiting in D1 until next_attempt_at; the cron dispatches it
--   queued     handed to the queue (or a waitUntil in direct mode)
--   sending    claimed by an attempt until lease_until
--   sent / failed / canceled  final
-- `attempts` counts started attempts; every claim compares it, so duplicate
-- queue messages and recovered deliveries never run the same attempt twice.
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  channel_group_slug TEXT,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'queued', 'sending', 'sent', 'failed', 'canceled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER,
  duration_ms INTEGER,
  http_status INTEGER,
  response_body TEXT,
  error TEXT,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_deliveries_message ON deliveries (message_id);
-- Only in-flight deliveries stay in this index; the cron scans it every minute.
CREATE INDEX idx_deliveries_pending ON deliveries (status, next_attempt_at)
  WHERE status IN ('scheduled', 'queued', 'sending');

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Minute buckets preserve local-day boundaries even in fractional-hour timezones.
-- Final outcomes per (channel, channelGroup). channel_group_slug is '' for messages
-- sent straight to channels. latency is send_at -> sent (successful only);
-- retries counts attempts beyond the first.
CREATE TABLE delivery_stats (
  bucket INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  channel_group_slug TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  latency_sum INTEGER NOT NULL DEFAULT 0,
  latency_max INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, channel_id, channel_group_slug)
) WITHOUT ROWID;
