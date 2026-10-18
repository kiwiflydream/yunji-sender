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
  delivery_count INTEGER NOT NULL DEFAULT 0,
  send_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE UNIQUE INDEX idx_messages_idem ON messages (idem) WHERE idem IS NOT NULL;
CREATE INDEX idx_messages_cursor ON messages (created_at DESC, id DESC);
CREATE INDEX idx_messages_channel_group_cursor ON messages (channel_group_slug, created_at DESC, id DESC);

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
  dispatch_count INTEGER NOT NULL DEFAULT 0,
  dispatch_after INTEGER NOT NULL DEFAULT 0,
  last_dispatched_at INTEGER,
  deadline_at INTEGER NOT NULL,
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

CREATE INDEX idx_deliveries_deadline ON deliveries (deadline_at)
  WHERE status IN ('scheduled', 'queued');

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

CREATE TABLE message_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  channel_group_slug TEXT,
  channel_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Built-in examples are editable. Choose targets before sending with just an id and variables.
INSERT INTO message_templates (id, name, description, content, created_at, updated_at) VALUES ('new-order', '新订单通知', '收到新订单时通知商家', '{"title":"你有一个新订单","body":"订单号：{{orderNo}}","format":"text","level":"info"}', unixepoch() * 1000, unixepoch() * 1000);
INSERT INTO message_templates (id, name, description, content, created_at, updated_at) VALUES ('payment-success', '支付成功', '订单支付成功后的通知', '{"title":"订单支付成功","body":"订单号：{{orderNo}}\n支付金额：{{amount}} 元","format":"text","level":"info"}', unixepoch() * 1000, unixepoch() * 1000);
INSERT INTO message_templates (id, name, description, content, created_at, updated_at) VALUES ('order-shipped', '发货通知', '订单发货后发送物流信息', '{"title":"你的订单已发货","body":"订单号：{{orderNo}}\n物流公司：{{carrier}}\n运单号：{{trackingNo}}","format":"text","level":"info"}', unixepoch() * 1000, unixepoch() * 1000);
INSERT INTO message_templates (id, name, description, content, created_at, updated_at) VALUES ('deployment-result', '部署结果', '记录服务发布结果', '{"title":"{{service}} 部署结果","body":"服务：{{service}}\n环境：{{environment}}\n版本：{{version}}\n结果：{{result}}","format":"text","level":"info"}', unixepoch() * 1000, unixepoch() * 1000);
INSERT INTO message_templates (id, name, description, content, created_at, updated_at) VALUES ('service-alert', '服务告警', '服务异常时发送告警', '{"title":"{{service}} 服务告警","body":"服务：{{service}}\n告警内容：{{message}}\n发生时间：{{time}}","format":"text","level":"error"}', unixepoch() * 1000, unixepoch() * 1000);

-- Atomic admission and execution budgets.
CREATE TABLE usage_counters (
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  used INTEGER NOT NULL,
  PRIMARY KEY (kind, scope, bucket)
) WITHOUT ROWID;

CREATE TRIGGER reserve_message_budget BEFORE INSERT ON messages WHEN NEW.delivery_count > 0 BEGIN
  SELECT CASE WHEN COALESCE((SELECT json_extract(value, '$.sendingPaused') FROM settings WHERE key='runtime'), 0) THEN RAISE(ABORT, 'safety:paused') END;
  INSERT INTO usage_counters (kind, scope, bucket, used) VALUES
    ('accepted-day', '*', NEW.created_at - NEW.created_at % 86400000, NEW.delivery_count),
    ('accepted-key-day', COALESCE('api:' || NEW.api_key_id, NEW.source), NEW.created_at - NEW.created_at % 86400000, NEW.delivery_count),
    ('accepted-key-minute', COALESCE('api:' || NEW.api_key_id, NEW.source), NEW.created_at - NEW.created_at % 60000, NEW.delivery_count)
    ON CONFLICT (kind, scope, bucket) DO UPDATE SET used = used + excluded.used;
  SELECT CASE WHEN (SELECT used FROM usage_counters WHERE kind='accepted-day' AND scope='*' AND bucket=NEW.created_at - NEW.created_at % 86400000) > COALESCE((SELECT json_extract(value, '$.dailyDeliveryLimit') FROM settings WHERE key='runtime'), 1000) THEN RAISE(ABORT, 'safety:daily') END;
  SELECT CASE WHEN (SELECT used FROM usage_counters WHERE kind='accepted-key-day' AND scope=COALESCE('api:' || NEW.api_key_id, NEW.source) AND bucket=NEW.created_at - NEW.created_at % 86400000) > COALESCE((SELECT json_extract(value, '$.perKeyDailyDeliveryLimit') FROM settings WHERE key='runtime'), 500) THEN RAISE(ABORT, 'safety:key_daily') END;
  SELECT CASE WHEN (SELECT used FROM usage_counters WHERE kind='accepted-key-minute' AND scope=COALESCE('api:' || NEW.api_key_id, NEW.source) AND bucket=NEW.created_at - NEW.created_at % 60000) > COALESCE((SELECT json_extract(value, '$.perKeyMinuteLimit') FROM settings WHERE key='runtime'), 100) THEN RAISE(ABORT, 'safety:rate') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM (SELECT 1 FROM deliveries WHERE status IN ('scheduled','queued','sending') LIMIT COALESCE((SELECT json_extract(value, '$.maxPendingDeliveries') FROM settings WHERE key='runtime'), 1000))) + NEW.delivery_count > COALESCE((SELECT json_extract(value, '$.maxPendingDeliveries') FROM settings WHERE key='runtime'), 1000) THEN RAISE(ABORT, 'safety:backlog') END;
END;
CREATE TRIGGER guard_work_insert BEFORE INSERT ON usage_counters WHEN NEW.kind='work' BEGIN
  SELECT CASE WHEN COALESCE((SELECT json_extract(value, '$.sendingPaused') FROM settings WHERE key='runtime'), 0) THEN RAISE(ABORT, 'safety:paused') END;
  SELECT CASE WHEN NEW.used > COALESCE((SELECT json_extract(value, '$.dailyWorkLimit') FROM settings WHERE key='runtime'), 3000) THEN RAISE(ABORT, 'safety:work') END;
END;
CREATE TRIGGER guard_work_update BEFORE UPDATE OF used ON usage_counters WHEN NEW.kind='work' BEGIN
  SELECT CASE WHEN COALESCE((SELECT json_extract(value, '$.sendingPaused') FROM settings WHERE key='runtime'), 0) THEN RAISE(ABORT, 'safety:paused') END;
  SELECT CASE WHEN NEW.used > COALESCE((SELECT json_extract(value, '$.dailyWorkLimit') FROM settings WHERE key='runtime'), 3000) THEN RAISE(ABORT, 'safety:work') END;
END;
CREATE TRIGGER reserve_dispatch_budget BEFORE UPDATE OF dispatch_count ON deliveries WHEN NEW.dispatch_count > OLD.dispatch_count BEGIN
  INSERT INTO usage_counters (kind, scope, bucket, used) VALUES
    ('work', '*', NEW.updated_at - NEW.updated_at % 86400000, 1)
    ON CONFLICT (kind, scope, bucket) DO UPDATE SET used = used + excluded.used;
END;
CREATE TRIGGER reserve_attempt_budget BEFORE UPDATE OF attempts ON deliveries WHEN NEW.attempts > OLD.attempts AND NEW.status='sending' BEGIN
  INSERT INTO usage_counters (kind, scope, bucket, used) VALUES
    ('work', '*', NEW.updated_at - NEW.updated_at % 86400000, 1)
    ON CONFLICT (kind, scope, bucket) DO UPDATE SET used = used + excluded.used;
END;
