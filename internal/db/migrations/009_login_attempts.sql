-- Migration 009: Per-identifier account lockout for brute-force protection.
CREATE TABLE IF NOT EXISTS login_attempts (
    identifier   TEXT PRIMARY KEY,  -- username or email (lower-cased)
    attempts     INTEGER NOT NULL DEFAULT 0,
    locked_until DATETIME,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
