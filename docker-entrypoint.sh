#!/bin/sh
set -e

SECRET_FILE="/app/data/.jwt_secret"

# ── Auto-generate JWT_SECRET if not provided ──────────────────────────────────
# Persists to /app/data so the same secret survives container restarts.
if [ -z "$JWT_SECRET" ]; then
    if [ -f "$SECRET_FILE" ]; then
        export JWT_SECRET=$(cat "$SECRET_FILE")
        echo "✦ JWT_SECRET loaded from $SECRET_FILE"
    else
        export JWT_SECRET=$(cat /dev/urandom | tr -dc 'a-f0-9' | head -c 64)
        echo "$JWT_SECRET" > "$SECRET_FILE"
        chmod 600 "$SECRET_FILE"
        echo "✦ JWT_SECRET generated and saved to $SECRET_FILE"
    fi
fi

exec /app/chirm "$@"
