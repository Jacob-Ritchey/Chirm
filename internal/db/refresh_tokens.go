package db

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"time"
)

const refreshTokenTTL = 30 * 24 * time.Hour

// CreateRefreshToken generates a new refresh token for the given user, stores
// its SHA-256 hash in the database, and returns the raw token to send to the
// client. The raw token is never stored.
func (d *DB) CreateRefreshToken(userID string) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	raw := hex.EncodeToString(b)
	hash := hashRefreshToken(raw)
	expires := time.Now().Add(refreshTokenTTL)

	_, err := d.Exec(
		`INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
		NewID(), userID, hash, expires,
	)
	if err != nil {
		return "", err
	}
	return raw, nil
}

// RotateRefreshToken validates the provided raw token, deletes it, and issues
// a new one. Returns (userID, newRawToken, error).
func (d *DB) RotateRefreshToken(rawToken string) (string, string, error) {
	hash := hashRefreshToken(rawToken)

	var userID string
	err := d.QueryRow(
		`SELECT user_id FROM refresh_tokens WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP`,
		hash,
	).Scan(&userID)
	if err != nil {
		return "", "", err
	}

	// Delete the used token.
	d.Exec(`DELETE FROM refresh_tokens WHERE token_hash = ?`, hash)

	// Issue a new one.
	newRaw, err := d.CreateRefreshToken(userID)
	if err != nil {
		return "", "", err
	}
	return userID, newRaw, nil
}

// RevokeRefreshTokensForUser deletes all refresh tokens for a user (on logout).
func (d *DB) RevokeRefreshTokensForUser(userID string) {
	d.Exec(`DELETE FROM refresh_tokens WHERE user_id = ?`, userID)
}

func hashRefreshToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}
