-- Support stable cursor ordering, including channelGroup-filtered lists.
CREATE INDEX idx_messages_cursor ON messages (created_at DESC, id DESC);
CREATE INDEX idx_messages_channel_group_cursor ON messages (channel_group_slug, created_at DESC, id DESC);
DROP INDEX idx_messages_created;
