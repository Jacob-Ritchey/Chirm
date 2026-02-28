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
		`SELECT id, username, email, password_hash, avatar, is_owner, created_at FROM users WHERE id = ?`, id,
	).Scan(&u.ID, &u.Username, &u.Email, &u.PasswordHash, &u.Avatar, &owner, &u.CreatedAt)
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
		`SELECT id, username, email, password_hash, avatar, is_owner, created_at FROM users WHERE username = ?`, username,
	).Scan(&u.ID, &u.Username, &u.Email, &u.PasswordHash, &u.Avatar, &owner, &u.CreatedAt)
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
		`SELECT id, username, email, password_hash, avatar, is_owner, created_at FROM users WHERE email = ?`, email,
	).Scan(&u.ID, &u.Username, &u.Email, &u.PasswordHash, &u.Avatar, &owner, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	u.IsOwner = owner == 1
	u.Roles, _ = d.GetUserRoles(u.ID)
	u.Permissions = d.ComputePermissions(u)
	return u, nil
}

func (d *DB) ListUsers() ([]User, error) {
	rows, err := d.Query(`SELECT id, username, email, avatar, is_owner, created_at FROM users ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		var u User
		var owner int
		rows.Scan(&u.ID, &u.Username, &u.Email, &u.Avatar, &owner, &u.CreatedAt)
		u.IsOwner = owner == 1
		u.Roles, _ = d.GetUserRoles(u.ID)
		users = append(users, u)
	}
	return users, nil
}

func (d *DB) ListUsersPaginated(before string, limit int) ([]User, error) {
	var rows *sql.Rows
	var err error
	if before == "" {
		rows, err = d.Query(`SELECT id, username, email, avatar, is_owner, created_at FROM users ORDER BY created_at ASC LIMIT ?`, limit)
	} else {
		rows, err = d.Query(`SELECT id, username, email, avatar, is_owner, created_at FROM users WHERE created_at > (SELECT created_at FROM users WHERE id = ?) ORDER BY created_at ASC LIMIT ?`, before, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		var u User
		var owner int
		rows.Scan(&u.ID, &u.Username, &u.Email, &u.Avatar, &owner, &u.CreatedAt)
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
