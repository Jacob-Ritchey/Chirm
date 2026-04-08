CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, avatar TEXT DEFAULT '', is_owner INTEGER DEFAULT 0, bio TEXT DEFAULT '', links TEXT DEFAULT '[]', banner TEXT DEFAULT '', status TEXT DEFAULT 'online', storage_used_bytes INTEGER DEFAULT 0, totp_secret TEXT DEFAULT '', totp_enabled INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT DEFAULT '#99AAB5', permissions INTEGER DEFAULT 3, position INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE user_roles (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, PRIMARY KEY (user_id, role_id));
CREATE TABLE push_subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, endpoint TEXT NOT NULL, data TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, endpoint));

CREATE UNIQUE INDEX idx_users_username ON users(username);
CREATE UNIQUE INDEX idx_users_email ON users(email);
CREATE INDEX idx_user_roles_user ON user_roles(user_id);
CREATE INDEX idx_push_subs_user ON push_subscriptions(user_id);
