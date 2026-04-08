package db

import "database/sql"

// --- Users ---

func (s *Store) CreateUser(username, email, hash string, isOwner bool) (*User, error) {
	id := NewID()
	owner := 0
	if isOwner {
		owner = 1
	}
	_, err := s.members.Exec(
		`INSERT INTO users (id, username, email, password_hash, is_owner) VALUES (?, ?, ?, ?, ?)`,
		id, username, email, hash, owner,
	)
	if err != nil {
		return nil, err
	}
	return s.GetUserByID(id)
}

func (s *Store) GetUserByID(id string) (*User, error) {
	u := &User{}
	var owner int
	err := s.members.QueryRow(
		`SELECT id, username, email, password_hash, avatar, COALESCE(bio,''), COALESCE(links,'[]'), COALESCE(banner,''), COALESCE(status,'online'), is_owner, created_at FROM users WHERE id = ?`, id,
	).Scan(&u.ID, &u.Username, &u.Email, &u.PasswordHash, &u.Avatar, &u.Bio, &u.Links, &u.Banner, &u.Status, &owner, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	u.IsOwner = owner == 1
	u.Roles, _ = s.GetUserRoles(id)
	u.Permissions = s.ComputePermissions(u)
	return u, nil
}

func (s *Store) GetUserByUsername(username string) (*User, error) {
	u := &User{}
	var owner int
	err := s.members.QueryRow(
		`SELECT id, username, email, password_hash, avatar, COALESCE(bio,''), COALESCE(links,'[]'), COALESCE(banner,''), COALESCE(status,'online'), is_owner, created_at FROM users WHERE username = ?`, username,
	).Scan(&u.ID, &u.Username, &u.Email, &u.PasswordHash, &u.Avatar, &u.Bio, &u.Links, &u.Banner, &u.Status, &owner, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	u.IsOwner = owner == 1
	u.Roles, _ = s.GetUserRoles(u.ID)
	u.Permissions = s.ComputePermissions(u)
	return u, nil
}

func (s *Store) GetUserByEmail(email string) (*User, error) {
	u := &User{}
	var owner int
	err := s.members.QueryRow(
		`SELECT id, username, email, password_hash, avatar, COALESCE(bio,''), COALESCE(links,'[]'), COALESCE(banner,''), COALESCE(status,'online'), is_owner, created_at FROM users WHERE email = ?`, email,
	).Scan(&u.ID, &u.Username, &u.Email, &u.PasswordHash, &u.Avatar, &u.Bio, &u.Links, &u.Banner, &u.Status, &owner, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	u.IsOwner = owner == 1
	u.Roles, _ = s.GetUserRoles(u.ID)
	u.Permissions = s.ComputePermissions(u)
	return u, nil
}

func (s *Store) ListUsers() ([]User, error) {
	rows, err := s.members.Query(`SELECT id, username, email, avatar, COALESCE(bio,''), COALESCE(links,'[]'), COALESCE(banner,''), COALESCE(status,'online'), is_owner, created_at FROM users ORDER BY created_at ASC`)
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
		u.Roles, _ = s.GetUserRoles(u.ID)
		users = append(users, u)
	}
	return users, nil
}

// GetStorageUsed returns how many bytes the user has used across all uploads.
func (s *Store) GetStorageUsed(userID string) int64 {
	var used int64
	s.members.QueryRow(`SELECT COALESCE(storage_used_bytes, 0) FROM users WHERE id = ?`, userID).Scan(&used)
	return used
}

// AddStorageUsed increments (or decrements with a negative delta) the user's
// storage counter atomically.
func (s *Store) AddStorageUsed(userID string, delta int64) {
	s.members.Exec(`UPDATE users SET storage_used_bytes = MAX(0, storage_used_bytes + ?) WHERE id = ?`, delta, userID)
}

func (s *Store) ListUsersPaginated(before string, limit int) ([]User, error) {
	var rows *sql.Rows
	var err error
	if before == "" {
		rows, err = s.members.Query(`SELECT id, username, email, avatar, COALESCE(bio,''), COALESCE(links,'[]'), COALESCE(banner,''), COALESCE(status,'online'), is_owner, created_at FROM users ORDER BY created_at ASC LIMIT ?`, limit)
	} else {
		rows, err = s.members.Query(`SELECT id, username, email, avatar, COALESCE(bio,''), COALESCE(links,'[]'), COALESCE(banner,''), COALESCE(status,'online'), is_owner, created_at FROM users WHERE created_at > (SELECT created_at FROM users WHERE id = ?) ORDER BY created_at ASC LIMIT ?`, before, limit)
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
		u.Roles, _ = s.GetUserRoles(u.ID)
		users = append(users, u)
	}
	return users, nil
}

func (s *Store) UpdateUser(id, username, avatar string) error {
	_, err := s.members.Exec(`UPDATE users SET username = ?, avatar = ? WHERE id = ?`, username, avatar, id)
	return err
}

func (s *Store) UpdateUserProfile(id, username, avatar, bio, links string) error {
	_, err := s.members.Exec(`UPDATE users SET username = ?, avatar = ?, bio = ?, links = ? WHERE id = ?`, username, avatar, bio, links, id)
	return err
}

func (s *Store) UpdateUserBanner(id, banner string) error {
	_, err := s.members.Exec(`UPDATE users SET banner = ? WHERE id = ?`, banner, id)
	return err
}

func (s *Store) UpdateUserStatus(id, status string) error {
	_, err := s.members.Exec(`UPDATE users SET status = ? WHERE id = ?`, status, id)
	return err
}

func (s *Store) DeleteUser(id string) error {
	_, err := s.members.Exec(`DELETE FROM users WHERE id = ?`, id)
	return err
}

func (s *Store) UserCount() int {
	var n int
	s.members.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n
}

// --- Permissions ---

func (s *Store) ComputePermissions(u *User) int {
	if u.IsOwner {
		return PermAdministrator | PermManageServer | PermManageRoles | PermManageChannels | PermManageMessages | PermSendMessages | PermReadMessages
	}
	perms := 0
	everyone, _ := s.GetEveryoneRole()
	if everyone != nil {
		perms |= everyone.Permissions
	}
	for _, r := range u.Roles {
		perms |= r.Permissions
	}
	return perms
}

func (s *Store) HasPermission(u *User, perm int) bool {
	p := u.Permissions
	if p&PermAdministrator != 0 {
		return true
	}
	return p&perm != 0
}
