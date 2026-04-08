-- Migration 008: Give each thread its own hidden channel.
-- Thread channels use type='thread' and are filtered from ListChannels.
ALTER TABLE threads ADD COLUMN thread_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL;
