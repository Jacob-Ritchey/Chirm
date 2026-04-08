package db

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

// CreateTOTPPendingSession issues a short-lived (5 min) pending token used to
// gate the second factor step of login. The token is returned to the client
// in the login response body (not a cookie) so the client can send it back
// with the TOTP code.
func (d *DB) CreateTOTPPendingSession(userID string) (string, error) {
	// Prune expired sessions first.
	d.Exec(`DELETE FROM totp_pending WHERE expires_at < CURRENT_TIMESTAMP`)

	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := hex.EncodeToString(b)
	expires := time.Now().Add(5 * time.Minute)

	_, err := d.Exec(
		`INSERT INTO totp_pending (token, user_id, expires_at) VALUES (?, ?, ?)`,
		token, userID, expires,
	)
	if err != nil {
		return "", err
	}
	return token, nil
}

// ConsumeTOTPPendingSession validates and deletes a pending session token.
// Returns the userID on success, empty string if unknown or expired.
func (d *DB) ConsumeTOTPPendingSession(token string) string {
	var userID string
	err := d.QueryRow(
		`SELECT user_id FROM totp_pending WHERE token = ? AND expires_at > CURRENT_TIMESTAMP`,
		token,
	).Scan(&userID)
	if err != nil {
		return ""
	}
	d.Exec(`DELETE FROM totp_pending WHERE token = ?`, token)
	return userID
}
