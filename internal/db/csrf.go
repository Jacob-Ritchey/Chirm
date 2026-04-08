package db

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

// IssueCSRFToken creates a new single-use CSRF token for the given user.
// Tokens expire after 5 minutes. Old expired tokens for the user are pruned
// at the same time to keep the table small.
func (d *DB) IssueCSRFToken(userID string) (string, error) {
	// Prune expired tokens for this user.
	d.Exec(`DELETE FROM csrf_tokens WHERE user_id = ? AND expires_at < CURRENT_TIMESTAMP`, userID)

	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := hex.EncodeToString(b)
	expires := time.Now().Add(5 * time.Minute)

	_, err := d.Exec(
		`INSERT INTO csrf_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`,
		token, userID, expires,
	)
	if err != nil {
		return "", err
	}
	return token, nil
}

// ConsumeCSRFToken validates and deletes a CSRF token. Returns the owning
// userID on success, empty string if the token is unknown or expired.
func (d *DB) ConsumeCSRFToken(token string) string {
	var userID string
	err := d.QueryRow(
		`SELECT user_id FROM csrf_tokens WHERE token = ? AND expires_at > CURRENT_TIMESTAMP`,
		token,
	).Scan(&userID)
	if err != nil {
		return ""
	}
	d.Exec(`DELETE FROM csrf_tokens WHERE token = ?`, token)
	return userID
}
