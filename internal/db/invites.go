package db

import (
	"database/sql"
	"os"
	"time"
)

// --- Invites ---

func (s *Store) CreateInvite(createdBy string, maxUses int, expiresAt *time.Time) (*Invite, error) {
	code := NewID()
	// Fetch creator username for denormalization.
	creatorUsername := ""
	if u, err := s.GetUserByID(createdBy); err == nil {
		creatorUsername = u.Username
	}
	if expiresAt != nil {
		_, err := s.server.Exec(
			`INSERT INTO invites (code, created_by, creator_username, max_uses, expires_at) VALUES (?, ?, ?, ?, ?)`,
			code, createdBy, creatorUsername, maxUses, expiresAt)
		if err != nil {
			return nil, err
		}
	} else {
		_, err := s.server.Exec(
			`INSERT INTO invites (code, created_by, creator_username, max_uses) VALUES (?, ?, ?, ?)`,
			code, createdBy, creatorUsername, maxUses)
		if err != nil {
			return nil, err
		}
	}
	return s.GetInviteByCode(code)
}

func (s *Store) GetInviteByCode(code string) (*Invite, error) {
	inv := &Invite{}
	var expires sql.NullTime
	err := s.server.QueryRow(
		`SELECT code, created_by, creator_username, uses, max_uses, expires_at, created_at FROM invites WHERE code = ?`, code).
		Scan(&inv.Code, &inv.CreatedBy, &inv.CreatorUsername, &inv.Uses, &inv.MaxUses, &expires, &inv.CreatedAt)
	if err != nil {
		return nil, err
	}
	if expires.Valid {
		inv.ExpiresAt = &expires.Time
	}
	return inv, nil
}

func (s *Store) ListInvites() ([]Invite, error) {
	rows, err := s.server.Query(`SELECT code, created_by, creator_username, uses, max_uses, expires_at, created_at FROM invites ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var invites []Invite
	for rows.Next() {
		var inv Invite
		var expires sql.NullTime
		rows.Scan(&inv.Code, &inv.CreatedBy, &inv.CreatorUsername, &inv.Uses, &inv.MaxUses, &expires, &inv.CreatedAt)
		if expires.Valid {
			inv.ExpiresAt = &expires.Time
		}
		invites = append(invites, inv)
	}
	return invites, nil
}

func (s *Store) ListInvitesPaginated(before string, limit int) ([]Invite, error) {
	var rows *sql.Rows
	var err error
	if before == "" {
		rows, err = s.server.Query(
			`SELECT code, created_by, creator_username, uses, max_uses, expires_at, created_at FROM invites ORDER BY created_at DESC LIMIT ?`, limit)
	} else {
		rows, err = s.server.Query(
			`SELECT code, created_by, creator_username, uses, max_uses, expires_at, created_at FROM invites WHERE created_at < (SELECT created_at FROM invites WHERE code = ?) ORDER BY created_at DESC LIMIT ?`, before, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var invites []Invite
	for rows.Next() {
		var inv Invite
		var expires sql.NullTime
		rows.Scan(&inv.Code, &inv.CreatedBy, &inv.CreatorUsername, &inv.Uses, &inv.MaxUses, &expires, &inv.CreatedAt)
		if expires.Valid {
			inv.ExpiresAt = &expires.Time
		}
		invites = append(invites, inv)
	}
	return invites, nil
}

func (s *Store) UseInvite(code string) error {
	_, err := s.server.Exec(`UPDATE invites SET uses = uses + 1 WHERE code = ?`, code)
	return err
}

// IsInviteValid returns true if the invite has not exceeded its use limit
// and has not passed its expiry time.
func (s *Store) IsInviteValid(inv *Invite) bool {
	if inv.MaxUses > 0 && inv.Uses >= inv.MaxUses {
		return false
	}
	if inv.ExpiresAt != nil && time.Now().After(*inv.ExpiresAt) {
		return false
	}
	return true
}

func (s *Store) DeleteInvite(code string) error {
	_, err := s.server.Exec(`DELETE FROM invites WHERE code = ?`, code)
	return err
}

// TruncateInviteChain removes the creator identity from an invite after it has
// been used. This destroys the "who invited whom" social graph at write time.
func (s *Store) TruncateInviteChain(code string) error {
	_, err := s.server.Exec(`UPDATE invites SET created_by = '', creator_username = '' WHERE code = ?`, code)
	return err
}

// CleanOrphanedAttachments deletes pending_attachments records (and their files
// on disk) that were never linked to a message and are older than maxAge.
func (s *Store) CleanOrphanedAttachments(uploadsDir string, maxAge time.Duration) error {
	cutoff := time.Now().Add(-maxAge)
	rows, err := s.server.Query(
		`SELECT id, filename FROM pending_attachments WHERE created_at < ?`, cutoff)
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
		if _, err := s.server.Exec(`DELETE FROM pending_attachments WHERE id = ?`, o.id); err != nil {
			continue
		}
		os.Remove(uploadsDir + "/" + o.filename)
	}
	return nil
}
