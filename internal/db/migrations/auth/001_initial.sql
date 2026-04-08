CREATE TABLE login_attempts (identifier TEXT PRIMARY KEY, attempts INTEGER DEFAULT 0, locked_until DATETIME, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE csrf_tokens (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at DATETIME NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE refresh_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, expires_at DATETIME NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE totp_backup_codes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, code_hash TEXT NOT NULL, used INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE totp_pending (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at DATETIME NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_totp_backup_user ON totp_backup_codes(user_id);
