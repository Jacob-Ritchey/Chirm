package db

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// SetTOTPSecret stores the unconfirmed TOTP secret for a user (totp_enabled remains 0
// until the user confirms with a valid code via ConfirmTOTP).
func (d *DB) SetTOTPSecret(userID, secret string) error {
	_, err := d.Exec(`UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?`, secret, userID)
	return err
}

// ConfirmTOTP marks TOTP as enabled for the user and stores 8 backup codes.
// Returns the plaintext backup codes (shown to the user once; stored only as hashes).
func (d *DB) ConfirmTOTP(userID string) ([]string, error) {
	if _, err := d.Exec(`UPDATE users SET totp_enabled = 1 WHERE id = ?`, userID); err != nil {
		return nil, err
	}

	// Remove any previous backup codes.
	d.Exec(`DELETE FROM totp_backup_codes WHERE user_id = ?`, userID)

	var codes []string
	for i := 0; i < 8; i++ {
		b := make([]byte, 5)
		rand.Read(b)
		plain := fmt.Sprintf("%X", b) // 10-char hex backup code
		hash := hashBackupCode(plain)
		d.Exec(
			`INSERT INTO totp_backup_codes (id, user_id, code_hash) VALUES (?, ?, ?)`,
			NewID(), userID, hash,
		)
		codes = append(codes, plain)
	}
	return codes, nil
}

// DisableTOTP removes the TOTP secret and backup codes for a user.
func (d *DB) DisableTOTP(userID string) error {
	d.Exec(`DELETE FROM totp_backup_codes WHERE user_id = ?`, userID)
	_, err := d.Exec(`UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?`, userID)
	return err
}

// GetTOTPSecret returns the stored TOTP secret and whether TOTP is enabled.
func (d *DB) GetTOTPSecret(userID string) (secret string, enabled bool) {
	var s *string
	var e int
	d.QueryRow(`SELECT totp_secret, totp_enabled FROM users WHERE id = ?`, userID).Scan(&s, &e)
	if s != nil {
		secret = *s
	}
	enabled = e == 1
	return
}

// UseBackupCode validates and consumes a backup code. Returns true if valid and unused.
func (d *DB) UseBackupCode(userID, code string) bool {
	hash := hashBackupCode(code)
	var id string
	err := d.QueryRow(
		`SELECT id FROM totp_backup_codes WHERE user_id = ? AND code_hash = ? AND used = 0`,
		userID, hash,
	).Scan(&id)
	if err != nil {
		return false
	}
	d.Exec(`UPDATE totp_backup_codes SET used = 1 WHERE id = ?`, id)
	return true
}

func hashBackupCode(plain string) string {
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:])
}
