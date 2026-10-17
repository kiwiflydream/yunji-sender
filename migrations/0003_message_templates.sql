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
