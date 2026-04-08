-- Migration 010: Single-use CSRF tokens for WebSocket upgrade handshake.
CREATE TABLE IF NOT EXISTS csrf_tokens (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
