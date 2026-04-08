package db

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"time"
)

// IssueCSRFToken creates a new single-use CSRF token for the given user.
// Tokens expire after 5 minutes. Old expired tokens for the user are pruned
// at the same time to keep the table small.
func (s *Store) IssueCSRFToken(userID string) (string, error) {
	s.auth.Exec(`DELETE FROM csrf_tokens WHERE user_id = ? AND expires_at < CURRENT_TIMESTAMP`, userID)

	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := hex.EncodeToString(b)
	expires := time.Now().UTC().Add(5 * time.Minute)

	_, err := s.auth.Exec(
		`INSERT INTO csrf_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`,
		token, userID, expires,
	)
	if err != nil {
		return "", err
	}
	return token, nil
}

// ConsumeCSRFToken validates and deletes a CSRF token. Returns the owning
// userID on success, empty string if the token is unknown or expired, and a
// non-nil error if the lookup failed due to a database error (distinct from an
// invalid token so callers can return 503 rather than 403).
func (s *Store) ConsumeCSRFToken(token string) (string, error) {
	var userID string
	err := s.auth.QueryRow(
		`SELECT user_id FROM csrf_tokens WHERE token = ? AND expires_at > CURRENT_TIMESTAMP`,
		token,
	).Scan(&userID)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	s.auth.Exec(`DELETE FROM csrf_tokens WHERE token = ?`, token)
	return userID, nil
}
