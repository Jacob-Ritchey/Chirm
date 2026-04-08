package db

import (
	"database/sql"
	"strings"
	"time"
)

// lockoutDurations defines the escalating lockout windows.
// Attempt thresholds: 5→5m, 10→15m, 15→1h, 20+→24h.
var lockoutDurations = []struct {
	threshold int
	duration  time.Duration
}{
	{20, 24 * time.Hour},
	{15, 1 * time.Hour},
	{10, 15 * time.Minute},
	{5, 5 * time.Minute},
}

// LoginAttemptState holds the current lockout state for an identifier.
type LoginAttemptState struct {
	Attempts    int
	LockedUntil *time.Time
}

func normalise(identifier string) string {
	return strings.ToLower(strings.TrimSpace(identifier))
}

// GetLoginAttemptState returns the current attempt count and lockout time for
// a username or email. Returns a zero-value struct if no record exists yet.
func (d *DB) GetLoginAttemptState(identifier string) LoginAttemptState {
	id := normalise(identifier)
	var state LoginAttemptState
	var lockedUntil sql.NullTime
	err := d.QueryRow(
		`SELECT attempts, locked_until FROM login_attempts WHERE identifier = ?`, id,
	).Scan(&state.Attempts, &lockedUntil)
	if err != nil {
		return state
	}
	if lockedUntil.Valid {
		t := lockedUntil.Time
		state.LockedUntil = &t
	}
	return state
}

// IsLocked reports whether the identifier is currently locked out.
func (d *DB) IsLocked(identifier string) (locked bool, until time.Time) {
	state := d.GetLoginAttemptState(identifier)
	if state.LockedUntil != nil && time.Now().Before(*state.LockedUntil) {
		return true, *state.LockedUntil
	}
	return false, time.Time{}
}

// RecordFailedLogin increments the failure counter and applies a lockout if a
// threshold is crossed.
func (d *DB) RecordFailedLogin(identifier string) {
	id := normalise(identifier)
	d.Exec(`
		INSERT INTO login_attempts (identifier, attempts, updated_at)
		VALUES (?, 1, CURRENT_TIMESTAMP)
		ON CONFLICT(identifier) DO UPDATE SET
			attempts   = attempts + 1,
			updated_at = CURRENT_TIMESTAMP
	`, id)

	state := d.GetLoginAttemptState(id)
	for _, l := range lockoutDurations {
		if state.Attempts >= l.threshold {
			until := time.Now().Add(l.duration)
			d.Exec(`UPDATE login_attempts SET locked_until = ? WHERE identifier = ?`, until, id)
			break
		}
	}
}

// ClearLoginAttempts resets the failure counter on a successful login.
func (d *DB) ClearLoginAttempts(identifier string) {
	d.Exec(`DELETE FROM login_attempts WHERE identifier = ?`, normalise(identifier))
}

// UnlockIdentifier allows an admin to manually clear a lockout.
func (d *DB) UnlockIdentifier(identifier string) {
	d.Exec(`DELETE FROM login_attempts WHERE identifier = ?`, normalise(identifier))
}
