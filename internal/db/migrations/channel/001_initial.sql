-- Messages, attachments and reactions live in every channel DB
-- (including thread channel DBs — threads are just channels).
CREATE TABLE messages (
    id             TEXT PRIMARY KEY,
    channel_id     TEXT NOT NULL,
    user_id        TEXT,
    bot_id         TEXT,
    author_username TEXT NOT NULL DEFAULT '',
    author_avatar   TEXT NOT NULL DEFAULT '',
    bot_name        TEXT NOT NULL DEFAULT '',
    content        TEXT NOT NULL,
    reply_to_id    TEXT,
    thread_id      TEXT,
    edited_at      DATETIME,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE attachments (
    id            TEXT PRIMARY KEY,
    message_id    TEXT REFERENCES messages(id) ON DELETE CASCADE,
    filename      TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size          INTEGER NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id, emoji)
);

-- thread_index: written only on thread create/delete (and a single-row UPDATE
-- per thread message for message_count / last_activity_at). Lives in the PARENT
-- channel's DB and is used for ListThreadsByChannel — never touched on message inserts.
CREATE TABLE thread_index (
    id                TEXT PRIMARY KEY,         -- thread ID (= thread_channel_id)
    thread_channel_id TEXT NOT NULL,             -- same as id; kept for explicitness
    name              TEXT NOT NULL,
    creator_username  TEXT NOT NULL DEFAULT '',
    source_message_id TEXT,                      -- null for gallery/forum posts without a source msg
    message_count     INTEGER DEFAULT 0,
    last_activity_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- thread: full thread record. Lives in the THREAD's own channel DB.
-- message_count and last_activity_at are updated here on every thread message write.
CREATE TABLE thread (
    id                TEXT PRIMARY KEY,
    channel_id        TEXT NOT NULL,             -- parent channel ID
    thread_channel_id TEXT NOT NULL,             -- same as id
    name              TEXT NOT NULL,
    creator_id        TEXT,
    creator_username  TEXT NOT NULL DEFAULT '',
    source_message_id TEXT,
    message_count     INTEGER DEFAULT 0,
    last_activity_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX idx_messages_channel_main ON messages(channel_id, created_at) WHERE thread_id IS NULL;
CREATE INDEX idx_messages_bot ON messages(bot_id);
CREATE INDEX idx_reactions_message ON reactions(message_id);
CREATE INDEX idx_thread_index_activity ON thread_index(last_activity_at DESC);
CREATE INDEX idx_thread_index_source ON thread_index(source_message_id);
