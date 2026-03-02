CREATE TABLE IF NOT EXISTS server_settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS users (
	id            TEXT PRIMARY KEY,
	username      TEXT UNIQUE NOT NULL,
	email         TEXT UNIQUE NOT NULL,
	password_hash TEXT NOT NULL,
	avatar        TEXT DEFAULT '',
	is_owner      INTEGER DEFAULT 0,
	created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS roles (
	id          TEXT PRIMARY KEY,
	name        TEXT NOT NULL,
	color       TEXT DEFAULT '#99AAB5',
	permissions INTEGER DEFAULT 3,
	position    INTEGER DEFAULT 0,
	created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_roles (
	user_id TEXT NOT NULL,
	role_id TEXT NOT NULL,
	PRIMARY KEY (user_id, role_id),
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
	FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channel_categories (
	id         TEXT PRIMARY KEY,
	name       TEXT NOT NULL,
	position   INTEGER DEFAULT 0,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channels (
	id          TEXT PRIMARY KEY,
	name        TEXT NOT NULL,
	description TEXT DEFAULT '',
	type        TEXT DEFAULT 'text',
	position    INTEGER DEFAULT 0,
	created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
	id         TEXT PRIMARY KEY,
	channel_id TEXT NOT NULL,
	user_id    TEXT,
	content    TEXT NOT NULL,
	edited_at  DATETIME,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS attachments (
	id            TEXT PRIMARY KEY,
	message_id    TEXT,
	filename      TEXT NOT NULL,
	original_name TEXT NOT NULL,
	mime_type     TEXT NOT NULL,
	size          INTEGER NOT NULL,
	created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS invites (
	code       TEXT PRIMARY KEY,
	created_by TEXT NOT NULL,
	uses       INTEGER DEFAULT 0,
	max_uses   INTEGER DEFAULT 0,
	expires_at DATETIME,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reactions (
	message_id TEXT NOT NULL,
	user_id    TEXT NOT NULL,
	emoji      TEXT NOT NULL,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (message_id, user_id, emoji),
	FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
	FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS custom_emojis (
	id          TEXT PRIMARY KEY,
	name        TEXT UNIQUE NOT NULL,
	filename    TEXT NOT NULL,
	uploader_id TEXT NOT NULL,
	created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
	id         TEXT PRIMARY KEY,
	user_id    TEXT NOT NULL,
	endpoint   TEXT NOT NULL,
	data       TEXT NOT NULL,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
	UNIQUE(user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_custom_emojis_name ON custom_emojis(name);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
