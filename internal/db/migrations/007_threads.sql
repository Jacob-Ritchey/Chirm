-- Migration 007: Threads
-- Adds a threads table and associates messages with threads.
-- Thread messages have thread_id set; channel main-feed messages have thread_id NULL.

CREATE TABLE IF NOT EXISTS threads (
    id                TEXT PRIMARY KEY,
    channel_id        TEXT NOT NULL,
    name              TEXT NOT NULL,
    creator_id        TEXT,
    source_message_id TEXT,
    message_count     INTEGER NOT NULL DEFAULT 0,
    last_activity_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (channel_id)         REFERENCES channels(id)  ON DELETE CASCADE,
    FOREIGN KEY (creator_id)         REFERENCES users(id)     ON DELETE SET NULL,
    FOREIGN KEY (source_message_id)  REFERENCES messages(id)  ON DELETE SET NULL
);

ALTER TABLE messages ADD COLUMN thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_threads_channel       ON threads(channel_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread       ON messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_channel_main ON messages(channel_id, created_at) WHERE thread_id IS NULL;
