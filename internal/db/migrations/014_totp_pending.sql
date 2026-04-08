-- Migration 014: Short-lived pending TOTP sessions for two-step login.
CREATE TABLE IF NOT EXISTS totp_pending (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
