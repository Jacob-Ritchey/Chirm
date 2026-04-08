package db

import "database/sql"

// --- Roles ---

func (s *Store) GetEveryoneRole() (*Role, error) {
	r := &Role{}
	err := s.members.QueryRow(`SELECT id, name, color, permissions, position, created_at FROM roles WHERE name = '@everyone' ORDER BY position ASC LIMIT 1`).
		Scan(&r.ID, &r.Name, &r.Color, &r.Permissions, &r.Position, &r.CreatedAt)
	if err != nil {
		return nil, err
	}
	return r, nil
}

func (s *Store) CreateRole(name, color string, permissions int) (*Role, error) {
	id := NewID()
	var pos int
	s.members.QueryRow(`SELECT COALESCE(MAX(position), 0) + 1 FROM roles`).Scan(&pos)
	_, err := s.members.Exec(`INSERT INTO roles (id, name, color, permissions, position) VALUES (?, ?, ?, ?, ?)`,
		id, name, color, permissions, pos)
	if err != nil {
		return nil, err
	}
	return s.GetRoleByID(id)
}

func (s *Store) GetRoleByID(id string) (*Role, error) {
	r := &Role{}
	err := s.members.QueryRow(`SELECT id, name, color, permissions, position, created_at FROM roles WHERE id = ?`, id).
		Scan(&r.ID, &r.Name, &r.Color, &r.Permissions, &r.Position, &r.CreatedAt)
	return r, err
}

func (s *Store) ListRoles() ([]Role, error) {
	rows, err := s.members.Query(`SELECT id, name, color, permissions, position, created_at FROM roles ORDER BY position ASC`)
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

func (s *Store) ListRolesPaginated(before string, limit int) ([]Role, error) {
	var rows *sql.Rows
	var err error
	if before == "" {
		rows, err = s.members.Query(`SELECT id, name, color, permissions, position, created_at FROM roles ORDER BY created_at ASC LIMIT ?`, limit)
	} else {
		rows, err = s.members.Query(`SELECT id, name, color, permissions, position, created_at FROM roles WHERE created_at > (SELECT created_at FROM roles WHERE id = ?) ORDER BY created_at ASC LIMIT ?`, before, limit)
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

func (s *Store) UpdateRole(id, name, color string, permissions int) error {
	_, err := s.members.Exec(`UPDATE roles SET name = ?, color = ?, permissions = ? WHERE id = ?`, name, color, permissions, id)
	return err
}

func (s *Store) DeleteRole(id string) error {
	_, err := s.members.Exec(`DELETE FROM roles WHERE id = ? AND name != '@everyone'`, id)
	return err
}

func (s *Store) GetUserRoles(userID string) ([]Role, error) {
	rows, err := s.members.Query(`
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

func (s *Store) AssignRole(userID, roleID string) error {
	_, err := s.members.Exec(`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`, userID, roleID)
	return err
}

func (s *Store) RemoveRole(userID, roleID string) error {
	_, err := s.members.Exec(`DELETE FROM user_roles WHERE user_id = ? AND role_id = ?`, userID, roleID)
	return err
}
