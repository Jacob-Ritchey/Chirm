CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
CREATE TABLE channel_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', type TEXT DEFAULT 'text', position INTEGER DEFAULT 0, emoji TEXT DEFAULT '', category_id TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT UNIQUE NOT NULL, permissions INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE custom_emojis (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, filename TEXT NOT NULL, uploader_id TEXT NOT NULL, uploader_username TEXT NOT NULL DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE invites (code TEXT PRIMARY KEY, created_by TEXT NOT NULL, creator_username TEXT NOT NULL DEFAULT '', uses INTEGER DEFAULT 0, max_uses INTEGER DEFAULT 0, expires_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);

-- Lightweight routing table: maps message_id → channel_id for REST endpoints
-- that only receive a message_id (edit, delete, react). Written on message create,
-- deleted on message delete.
CREATE TABLE message_routes (message_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL);

-- Holds uploaded attachments until they are linked to a message via LinkAttachment.
-- After linking the record moves into the channel DB's attachments table.
CREATE TABLE pending_attachments (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    filename     TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type    TEXT NOT NULL,
    size         INTEGER NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_channels_category ON channels(category_id);
CREATE INDEX idx_channels_position ON channels(position);
CREATE UNIQUE INDEX idx_bots_token ON bots(token);
CREATE UNIQUE INDEX idx_custom_emojis_name ON custom_emojis(name);
