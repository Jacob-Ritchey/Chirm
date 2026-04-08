package db

import "database/sql"

// --- Users ---

func (d *DB) CreateUser(username, email, hash string, isOwner bool) (*User, error) {
	id := NewID()
	owner := 0
	if isOwner {
		owner = 1
	}
	_, err := d.Exec(
		`INSERT INTO users (id, username, email, password_hash, is_owner) VALUES (?, ?, ?, ?, ?)`,
		id, username, email, hash, owner,
	)
	if err != nil {
		return nil, err
	}
	return d.GetUserByID(id)
}

func (d *DB) GetUserByID(id string) (*User, error) {
	u := &User{}
	var owner int
	err := d.QueryRow(
		`SELECT id, username, email, password_hash, avatar, COALESCE(bio,''), COALESCE(links,'[]'), COALESCE(banner,''), COALESCE(status,'online'), is_owner, created_at FROM users WHERE id = ?`, id,
	).Scan(&u.ID, &u.Username, &u.Email, &u.PasswordHash, &u.Avatar, &u.Bio, &u.Links, &u.Banner, &u.Status, &owner, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	u.IsOwner = owner == 1
	u.Roles, _ = d.GetUserRoles(id)
	u.Permissions = d.ComputePermissions(u)
	return u, nil
}

func (d *DB) GetUserByUsername(username string) (*User, error) {
	u := &User{}
	var owner int
	err := d.QueryRow(
		`SELECT id, username, email, password_hash, avatar, COALESCE(bio,''), COALESCE(links,'[]'), COALESCE(banner,''), COALESCE(status,'online'), is_owner, created_at FROM users WHERE username = ?`, username,
	).Scan(&u.ID, &u.Username, &u.Email, &u.PasswordHash, &u.Avatar, &u.Bio, &u.Links, &u.Banner, &u.Status, &owner, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	u.IsOwner = owner == 1
	u.Roles, _ = d.GetUserRoles(u.ID)
	u.Permissions = d.ComputePermissions(u)
	return u, nil
}

func (d *DB) GetUserByEmail(email string) (*User, error) {
	u := &User{}
	var owner int
	err := d.QueryRow(
		`SELECT id, username, email, password_hash, avatar, COALESCE(bio,''), COALESCE(links,'[]'), COALESCE(banner,''), COALESCE(status,'online'), is_owner, created_at FROM users WHERE email = ?`, email,
	).Scan(&u.ID, &u.Username, &u.Email, &u.PasswordHash, &u.Avatar, &u.Bio, &u.Links, &u.Banner, &u.Status, &owner, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	u.IsOwner = owner == 1
	u.Roles, _ = d.GetUserRoles(u.ID)
	u.Permissions = d.ComputePermissions(u)
	return u, nil
}

func (d *DB) ListUsers() ([]User, error) {
	rows, err := d.Query(`SELECT id, username, email, avatar, COALESCE(bio,''), COALESCE(links,'[]'), COALESCE(banner,''), COALESCE(status,'online'), is_owner, created_at FROM users ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		var u User
		var owner int
		rows.Scan(&u.ID, &u.Username, &u.Email, &u.Avatar, &u.Bio, &u.Links, &u.Banner, &u.Status, &owner, &u.CreatedAt)
		u.IsOwner = owner == 1
		u.Roles, _ = d.GetUserRoles(u.ID)
		users = append(users, u)
	}
	return users, nil
}

// GetStorageUsed returns how many bytes the user has used across all uploads.
func (d *DB) GetStorageUsed(userID string) int64 {
	var used int64
	d.QueryRow(`SELECT COALESCE(storage_used_bytes, 0) FROM users WHERE id = ?`, userID).Scan(&used)
	return used
}

// AddStorageUsed increments (or decrements with a negative delta) the user's
// storage counter atomically.
func (d *DB) AddStorageUsed(userID string, delta int64) {
	d.Exec(`UPDATE users SET storage_used_bytes = MAX(0, storage_used_bytes + ?) WHERE id = ?`, delta, userID)
}

// ReconcileStorageUsed recomputes a user's storage_used_bytes from actual
// attachment sizes in the database. Used by the background reconciliation job.
func (d *DB) ReconcileStorageUsed(userID string) {
	d.Exec(`
		UPDATE users SET storage_used_bytes = (
			SELECT COALESCE(SUM(a.size), 0)
			FROM attachments a
			JOIN messages m ON a.message_id = m.id
			WHERE m.user_id = ?
		) WHERE id = ?
	`, userID, userID)
}

// ReconcileAllStorageUsed recomputes storage counters for all users in a single
// update. Called by the background cleanup goroutine once per hour.
func (d *DB) ReconcileAllStorageUsed() {
	d.Exec(`
		UPDATE users SET storage_used_bytes = (
			SELECT COALESCE(SUM(a.size), 0)
			FROM attachments a
			JOIN messages m ON a.message_id = m.id
			WHERE m.user_id = users.id
		)
	`)
}

func (d *DB) ListUsersPaginated(before string, limit int) ([]User, error) {
	var rows *sql.Rows
	var err error
	if before == "" {
		rows, err = d.Query(`SELECT id, username, email, avatar, COALESCE(bio,''), COALESCE(links,'[]'), COALESCE(banner,''), COALESCE(status,'online'), is_owner, created_at FROM users ORDER BY created_at ASC LIMIT ?`, limit)
	} else {
		rows, err = d.Query(`SELECT id, username, email, avatar, COALESCE(bio,''), COALESCE(links,'[]'), COALESCE(banner,''), COALESCE(status,'online'), is_owner, created_at FROM users WHERE created_at > (SELECT created_at FROM users WHERE id = ?) ORDER BY created_at ASC LIMIT ?`, before, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		var u User
		var owner int
		rows.Scan(&u.ID, &u.Username, &u.Email, &u.Avatar, &u.Bio, &u.Links, &u.Banner, &u.Status, &owner, &u.CreatedAt)
		u.IsOwner = owner == 1
		u.Roles, _ = d.GetUserRoles(u.ID)
		users = append(users, u)
	}
	return users, nil
}

func (d *DB) UpdateUser(id, username, avatar string) error {
	_, err := d.Exec(`UPDATE users SET username = ?, avatar = ? WHERE id = ?`, username, avatar, id)
	return err
}

func (d *DB) UpdateUserProfile(id, username, avatar, bio, links string) error {
	_, err := d.Exec(`UPDATE users SET username = ?, avatar = ?, bio = ?, links = ? WHERE id = ?`, username, avatar, bio, links, id)
	return err
}

func (d *DB) UpdateUserBanner(id, banner string) error {
	_, err := d.Exec(`UPDATE users SET banner = ? WHERE id = ?`, banner, id)
	return err
}

func (d *DB) UpdateUserStatus(id, status string) error {
	_, err := d.Exec(`UPDATE users SET status = ? WHERE id = ?`, status, id)
	return err
}

func (d *DB) DeleteUser(id string) error {
	_, err := d.Exec(`DELETE FROM users WHERE id = ?`, id)
	return err
}

func (d *DB) UserCount() int {
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n
}

// --- Permissions ---

func (d *DB) ComputePermissions(u *User) int {
	if u.IsOwner {
		return PermAdministrator | PermManageServer | PermManageRoles | PermManageChannels | PermManageMessages | PermSendMessages | PermReadMessages
	}
	perms := 0
	// @everyone base permissions
	everyone, _ := d.GetEveryoneRole()
	if everyone != nil {
		perms |= everyone.Permissions
	}
	for _, r := range u.Roles {
		perms |= r.Permissions
	}
	return perms
}

func (d *DB) HasPermission(u *User, perm int) bool {
	p := u.Permissions
	if p&PermAdministrator != 0 {
		return true
	}
	return p&perm != 0
}
