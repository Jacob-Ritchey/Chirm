package db

import (
	"database/sql"
	"os"
	"time"
)

// --- Invites ---

func (d *DB) CreateInvite(createdBy string, maxUses int, expiresAt *time.Time) (*Invite, error) {
	code := NewID()
	if expiresAt != nil {
		_, err := d.Exec(`INSERT INTO invites (code, created_by, max_uses, expires_at) VALUES (?, ?, ?, ?)`,
			code, createdBy, maxUses, expiresAt)
		if err != nil {
			return nil, err
		}
	} else {
		_, err := d.Exec(`INSERT INTO invites (code, created_by, max_uses) VALUES (?, ?, ?)`,
			code, createdBy, maxUses)
		if err != nil {
			return nil, err
		}
	}
	return d.GetInviteByCode(code)
}

func (d *DB) GetInviteByCode(code string) (*Invite, error) {
	inv := &Invite{}
	var expires sql.NullTime
	err := d.QueryRow(`SELECT code, created_by, uses, max_uses, expires_at, created_at FROM invites WHERE code = ?`, code).
		Scan(&inv.Code, &inv.CreatedBy, &inv.Uses, &inv.MaxUses, &expires, &inv.CreatedAt)
	if err != nil {
		return nil, err
	}
	if expires.Valid {
		inv.ExpiresAt = &expires.Time
	}
	inv.Creator, _ = d.GetUserByID(inv.CreatedBy)
	return inv, nil
}

func (d *DB) ListInvites() ([]Invite, error) {
	rows, err := d.Query(`SELECT code, created_by, uses, max_uses, expires_at, created_at FROM invites ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var invites []Invite
	for rows.Next() {
		var inv Invite
		var expires sql.NullTime
		rows.Scan(&inv.Code, &inv.CreatedBy, &inv.Uses, &inv.MaxUses, &expires, &inv.CreatedAt)
		if expires.Valid {
			inv.ExpiresAt = &expires.Time
		}
		inv.Creator, _ = d.GetUserByID(inv.CreatedBy)
		invites = append(invites, inv)
	}
	return invites, nil
}

func (d *DB) ListInvitesPaginated(before string, limit int) ([]Invite, error) {
	var rows *sql.Rows
	var err error
	if before == "" {
		rows, err = d.Query(`SELECT code, created_by, uses, max_uses, expires_at, created_at FROM invites ORDER BY created_at DESC LIMIT ?`, limit)
	} else {
		rows, err = d.Query(`SELECT code, created_by, uses, max_uses, expires_at, created_at FROM invites WHERE created_at < (SELECT created_at FROM invites WHERE code = ?) ORDER BY created_at DESC LIMIT ?`, before, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var invites []Invite
	for rows.Next() {
		var inv Invite
		var expires sql.NullTime
		rows.Scan(&inv.Code, &inv.CreatedBy, &inv.Uses, &inv.MaxUses, &expires, &inv.CreatedAt)
		if expires.Valid {
			inv.ExpiresAt = &expires.Time
		}
		inv.Creator, _ = d.GetUserByID(inv.CreatedBy)
		invites = append(invites, inv)
	}
	return invites, nil
}

func (d *DB) UseInvite(code string) error {
	_, err := d.Exec(`UPDATE invites SET uses = uses + 1 WHERE code = ?`, code)
	return err
}

// IsInviteValid returns true if the invite has not exceeded its use limit
// and has not passed its expiry time.
func (d *DB) IsInviteValid(inv *Invite) bool {
	if inv.MaxUses > 0 && inv.Uses >= inv.MaxUses {
		return false
	}
	if inv.ExpiresAt != nil && time.Now().After(*inv.ExpiresAt) {
		return false
	}
	return true
}

func (d *DB) DeleteInvite(code string) error {
	_, err := d.Exec(`DELETE FROM invites WHERE code = ?`, code)
	return err
}

// CleanOrphanedAttachments deletes attachment records (and their files on disk)
// that were never linked to a message and are older than maxAge.
func (d *DB) CleanOrphanedAttachments(uploadsDir string, maxAge time.Duration) error {
	cutoff := time.Now().Add(-maxAge)
	rows, err := d.Query(
		`SELECT id, filename FROM attachments WHERE message_id IS NULL AND created_at < ?`, cutoff)
	if err != nil {
		return err
	}

	type orphan struct{ id, filename string }
	var orphans []orphan
	for rows.Next() {
		var o orphan
		if rows.Scan(&o.id, &o.filename) == nil {
			orphans = append(orphans, o)
		}
	}
	rows.Close()

	for _, o := range orphans {
		// Delete DB record first; if that fails, leave the file so it can be
		// retried on the next cleanup cycle rather than leaving a dangling record.
		if _, err := d.Exec(`DELETE FROM attachments WHERE id = ?`, o.id); err != nil {
			continue
		}
		os.Remove(uploadsDir + "/" + o.filename)
	}
	return nil
}
