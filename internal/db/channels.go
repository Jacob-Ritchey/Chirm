package db

import "database/sql"

// --- Channels ---

func (s *Store) CreateChannel(name, description, chType, emoji, categoryID string) (*Channel, error) {
	id := NewID()
	var pos int
	s.server.QueryRow(`SELECT COALESCE(MAX(position), 0) + 1 FROM channels WHERE category_id = ?`, categoryID).Scan(&pos)
	encDesc, err := s.encryptField(id, "channel-description", description)
	if err != nil {
		return nil, err
	}
	_, err = s.server.Exec(`INSERT INTO channels (id, name, description, type, position, emoji, category_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, name, encDesc, chType, pos, emoji, categoryID)
	if err != nil {
		return nil, err
	}
	// Create the channel's own DB file.
	if _, err := s.channels.Create(id); err != nil {
		// Clean up channel record on DB creation failure.
		s.server.Exec(`DELETE FROM channels WHERE id = ?`, id)
		return nil, err
	}
	return s.GetChannelByID(id)
}

func (s *Store) GetChannelByID(id string) (*Channel, error) {
	c := &Channel{}
	err := s.server.QueryRow(`SELECT id, name, description, type, position, COALESCE(emoji,''), COALESCE(category_id,''), created_at FROM channels WHERE id = ?`, id).
		Scan(&c.ID, &c.Name, &c.Description, &c.Type, &c.Position, &c.Emoji, &c.CategoryID, &c.CreatedAt)
	if err != nil {
		return nil, err
	}
	c.Description = s.decryptField(c.ID, "channel-description", c.Description)
	return c, nil
}

func (s *Store) ListChannels() ([]Channel, error) {
	rows, err := s.server.Query(`SELECT id, name, description, type, position, COALESCE(emoji,''), COALESCE(category_id,''), created_at FROM channels WHERE type != 'thread' ORDER BY category_id ASC, position ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var channels []Channel
	for rows.Next() {
		var c Channel
		rows.Scan(&c.ID, &c.Name, &c.Description, &c.Type, &c.Position, &c.Emoji, &c.CategoryID, &c.CreatedAt)
		c.Description = s.decryptField(c.ID, "channel-description", c.Description)
		channels = append(channels, c)
	}
	return channels, nil
}

func (s *Store) ListChannelsPaginated(before string, limit int) ([]Channel, error) {
	var rows *sql.Rows
	var err error
	if before == "" {
		rows, err = s.server.Query(`SELECT id, name, description, type, position, COALESCE(emoji,''), COALESCE(category_id,''), created_at FROM channels WHERE type != 'thread' ORDER BY category_id ASC, position ASC LIMIT ?`, limit)
	} else {
		rows, err = s.server.Query(`SELECT id, name, description, type, position, COALESCE(emoji,''), COALESCE(category_id,''), created_at FROM channels WHERE type != 'thread' AND created_at > (SELECT created_at FROM channels WHERE id = ?) ORDER BY category_id ASC, position ASC LIMIT ?`, before, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var channels []Channel
	for rows.Next() {
		var c Channel
		rows.Scan(&c.ID, &c.Name, &c.Description, &c.Type, &c.Position, &c.Emoji, &c.CategoryID, &c.CreatedAt)
		c.Description = s.decryptField(c.ID, "channel-description", c.Description)
		channels = append(channels, c)
	}
	return channels, nil
}

func (s *Store) UpdateChannel(id, name, description, emoji, categoryID string) error {
	encDesc, err := s.encryptField(id, "channel-description", description)
	if err != nil {
		return err
	}
	_, err = s.server.Exec(`UPDATE channels SET name = ?, description = ?, emoji = ?, category_id = ? WHERE id = ?`, name, encDesc, emoji, categoryID, id)
	return err
}

// DeleteChannel removes the channel record from server.db and deletes the
// channel's own database file.
func (s *Store) DeleteChannel(id string) error {
	if _, err := s.server.Exec(`DELETE FROM channels WHERE id = ?`, id); err != nil {
		return err
	}
	return s.channels.Delete(id)
}

func (s *Store) ReorderChannels(orders []struct {
	ID         string
	Position   int
	CategoryID string
}) error {
	tx, err := s.server.Begin()
	if err != nil {
		return err
	}
	for _, o := range orders {
		if _, err := tx.Exec(`UPDATE channels SET position = ?, category_id = ? WHERE id = ?`, o.Position, o.CategoryID, o.ID); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// --- Channel Categories ---

func (s *Store) CreateCategory(name string) (*ChannelCategory, error) {
	id := NewID()
	var pos int
	s.server.QueryRow(`SELECT COALESCE(MAX(position), 0) + 1 FROM channel_categories`).Scan(&pos)
	_, err := s.server.Exec(`INSERT INTO channel_categories (id, name, position) VALUES (?, ?, ?)`, id, name, pos)
	if err != nil {
		return nil, err
	}
	cat := &ChannelCategory{}
	s.server.QueryRow(`SELECT id, name, position, created_at FROM channel_categories WHERE id = ?`, id).
		Scan(&cat.ID, &cat.Name, &cat.Position, &cat.CreatedAt)
	return cat, nil
}

func (s *Store) ListCategories() ([]ChannelCategory, error) {
	rows, err := s.server.Query(`SELECT id, name, position, created_at FROM channel_categories ORDER BY position ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cats []ChannelCategory
	for rows.Next() {
		var c ChannelCategory
		rows.Scan(&c.ID, &c.Name, &c.Position, &c.CreatedAt)
		cats = append(cats, c)
	}
	if cats == nil {
		cats = []ChannelCategory{}
	}
	return cats, nil
}

func (s *Store) UpdateCategory(id, name string) error {
	_, err := s.server.Exec(`UPDATE channel_categories SET name = ? WHERE id = ?`, name, id)
	return err
}

func (s *Store) DeleteCategory(id string) error {
	if _, err := s.server.Exec(`UPDATE channels SET category_id = '' WHERE category_id = ?`, id); err != nil {
		return err
	}
	_, err := s.server.Exec(`DELETE FROM channel_categories WHERE id = ?`, id)
	return err
}

func (s *Store) ReorderCategories(orders []struct {
	ID       string
	Position int
}) error {
	tx, err := s.server.Begin()
	if err != nil {
		return err
	}
	for _, o := range orders {
		if _, err := tx.Exec(`UPDATE channel_categories SET position = ? WHERE id = ?`, o.Position, o.ID); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}
