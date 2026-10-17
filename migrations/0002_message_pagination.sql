-- Support stable cursor ordering, including topic-filtered lists.
CREATE INDEX idx_messages_cursor ON messages (created_at DESC, id DESC);
CREATE INDEX idx_messages_topic_cursor ON messages (topic_slug, created_at DESC, id DESC);
DROP INDEX idx_messages_created;
