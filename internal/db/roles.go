package db

import "database/sql"

// --- Roles ---

func (d *DB) GetEveryoneRole() (*Role, error) {
	r := &Role{}
	err := d.QueryRow(`SELECT id, name, color, permissions, position, created_at FROM roles WHERE name = '@everyone' ORDER BY position ASC LIMIT 1`).
		Scan(&r.ID, &r.Name, &r.Color, &r.Permissions, &r.Position, &r.CreatedAt)
	if err != nil {
		return nil, err
	}
	return r, nil
}

func (d *DB) CreateRole(name, color string, permissions int) (*Role, error) {
	id := NewID()
	var pos int
	d.QueryRow(`SELECT COALESCE(MAX(position), 0) + 1 FROM roles`).Scan(&pos)
	_, err := d.Exec(`INSERT INTO roles (id, name, color, permissions, position) VALUES (?, ?, ?, ?, ?)`,
		id, name, color, permissions, pos)
	if err != nil {
		return nil, err
	}
	return d.GetRoleByID(id)
}

func (d *DB) GetRoleByID(id string) (*Role, error) {
	r := &Role{}
	err := d.QueryRow(`SELECT id, name, color, permissions, position, created_at FROM roles WHERE id = ?`, id).
		Scan(&r.ID, &r.Name, &r.Color, &r.Permissions, &r.Position, &r.CreatedAt)
	return r, err
}

func (d *DB) ListRoles() ([]Role, error) {
	rows, err := d.Query(`SELECT id, name, color, permissions, position, created_at FROM roles ORDER BY position ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roles []Role
	for rows.Next() {
		var r Role
		rows.Scan(&r.ID, &r.Name, &r.Color, &r.Permissions, &r.Position, &r.CreatedAt)
		roles = append(roles, r)
	}
	return roles, nil
}

func (d *DB) ListRolesPaginated(before string, limit int) ([]Role, error) {
	var rows *sql.Rows
	var err error
	if before == "" {
		rows, err = d.Query(`SELECT id, name, color, permissions, position, created_at FROM roles ORDER BY created_at ASC LIMIT ?`, limit)
	} else {
		rows, err = d.Query(`SELECT id, name, color, permissions, position, created_at FROM roles WHERE created_at > (SELECT created_at FROM roles WHERE id = ?) ORDER BY created_at ASC LIMIT ?`, before, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roles []Role
	for rows.Next() {
		var r Role
		rows.Scan(&r.ID, &r.Name, &r.Color, &r.Permissions, &r.Position, &r.CreatedAt)
		roles = append(roles, r)
	}
	return roles, nil
}

func (d *DB) UpdateRole(id, name, color string, permissions int) error {
	_, err := d.Exec(`UPDATE roles SET name = ?, color = ?, permissions = ? WHERE id = ?`, name, color, permissions, id)
	return err
}

func (d *DB) DeleteRole(id string) error {
	_, err := d.Exec(`DELETE FROM roles WHERE id = ? AND name != '@everyone'`, id)
	return err
}

func (d *DB) GetUserRoles(userID string) ([]Role, error) {
	rows, err := d.Query(`
		SELECT r.id, r.name, r.color, r.permissions, r.position, r.created_at
		FROM roles r
		JOIN user_roles ur ON r.id = ur.role_id
		WHERE ur.user_id = ?
		ORDER BY r.position ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roles []Role
	for rows.Next() {
		var r Role
		rows.Scan(&r.ID, &r.Name, &r.Color, &r.Permissions, &r.Position, &r.CreatedAt)
		roles = append(roles, r)
	}
	return roles, nil
}

func (d *DB) AssignRole(userID, roleID string) error {
	_, err := d.Exec(`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`, userID, roleID)
	return err
}

func (d *DB) RemoveRole(userID, roleID string) error {
	_, err := d.Exec(`DELETE FROM user_roles WHERE user_id = ? AND role_id = ?`, userID, roleID)
	return err
}
