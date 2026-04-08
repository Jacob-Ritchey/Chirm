-- Migration 012: Per-user storage usage tracking for quota enforcement.
ALTER TABLE users ADD COLUMN storage_used_bytes INTEGER NOT NULL DEFAULT 0;
