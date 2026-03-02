CREATE TABLE IF NOT EXISTS bots (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    token       TEXT UNIQUE NOT NULL,
    permissions INTEGER DEFAULT 3,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE messages ADD COLUMN bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bots_token ON bots(token);
CREATE INDEX IF NOT EXISTS idx_messages_bot  ON messages(bot_id);
