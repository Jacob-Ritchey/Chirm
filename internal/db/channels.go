package db

import "database/sql"

// --- Channels ---

func (d *DB) CreateChannel(name, description, chType, emoji, categoryID string) (*Channel, error) {
	id := NewID()
	var pos int
	d.QueryRow(`SELECT COALESCE(MAX(position), 0) + 1 FROM channels WHERE category_id = ?`, categoryID).Scan(&pos)
	_, err := d.Exec(`INSERT INTO channels (id, name, description, type, position, emoji, category_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, name, description, chType, pos, emoji, categoryID)
	if err != nil {
		return nil, err
	}
	return d.GetChannelByID(id)
}

func (d *DB) GetChannelByID(id string) (*Channel, error) {
	c := &Channel{}
	err := d.QueryRow(`SELECT id, name, description, type, position, COALESCE(emoji,''), COALESCE(category_id,''), created_at FROM channels WHERE id = ?`, id).
		Scan(&c.ID, &c.Name, &c.Description, &c.Type, &c.Position, &c.Emoji, &c.CategoryID, &c.CreatedAt)
	return c, err
}

func (d *DB) ListChannels() ([]Channel, error) {
	rows, err := d.Query(`SELECT id, name, description, type, position, COALESCE(emoji,''), COALESCE(category_id,''), created_at FROM channels ORDER BY category_id ASC, position ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var channels []Channel
	for rows.Next() {
		var c Channel
		rows.Scan(&c.ID, &c.Name, &c.Description, &c.Type, &c.Position, &c.Emoji, &c.CategoryID, &c.CreatedAt)
		channels = append(channels, c)
	}
	return channels, nil
}

func (d *DB) ListChannelsPaginated(before string, limit int) ([]Channel, error) {
	var rows *sql.Rows
	var err error
	if before == "" {
		rows, err = d.Query(`SELECT id, name, description, type, position, COALESCE(emoji,''), COALESCE(category_id,''), created_at FROM channels ORDER BY category_id ASC, position ASC LIMIT ?`, limit)
	} else {
		rows, err = d.Query(`SELECT id, name, description, type, position, COALESCE(emoji,''), COALESCE(category_id,''), created_at FROM channels WHERE created_at > (SELECT created_at FROM channels WHERE id = ?) ORDER BY category_id ASC, position ASC LIMIT ?`, before, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var channels []Channel
	for rows.Next() {
		var c Channel
		rows.Scan(&c.ID, &c.Name, &c.Description, &c.Type, &c.Position, &c.Emoji, &c.CategoryID, &c.CreatedAt)
		channels = append(channels, c)
	}
	return channels, nil
}

func (d *DB) UpdateChannel(id, name, description, emoji, categoryID string) error {
	_, err := d.Exec(`UPDATE channels SET name = ?, description = ?, emoji = ?, category_id = ? WHERE id = ?`, name, description, emoji, categoryID, id)
	return err
}

func (d *DB) DeleteChannel(id string) error {
	_, err := d.Exec(`DELETE FROM channels WHERE id = ?`, id)
	return err
}

func (d *DB) ReorderChannels(orders []struct {
	ID         string
	Position   int
	CategoryID string
}) error {
	tx, err := d.Begin()
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

func (d *DB) CreateCategory(name string) (*ChannelCategory, error) {
	id := NewID()
	var pos int
	d.QueryRow(`SELECT COALESCE(MAX(position), 0) + 1 FROM channel_categories`).Scan(&pos)
	_, err := d.Exec(`INSERT INTO channel_categories (id, name, position) VALUES (?, ?, ?)`, id, name, pos)
	if err != nil {
		return nil, err
	}
	cat := &ChannelCategory{}
	d.QueryRow(`SELECT id, name, position, created_at FROM channel_categories WHERE id = ?`, id).
		Scan(&cat.ID, &cat.Name, &cat.Position, &cat.CreatedAt)
	return cat, nil
}

func (d *DB) ListCategories() ([]ChannelCategory, error) {
	rows, err := d.Query(`SELECT id, name, position, created_at FROM channel_categories ORDER BY position ASC`)
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

func (d *DB) UpdateCategory(id, name string) error {
	_, err := d.Exec(`UPDATE channel_categories SET name = ? WHERE id = ?`, name, id)
	return err
}

func (d *DB) DeleteCategory(id string) error {
	// Move channels in this category to uncategorized before deleting
	if _, err := d.Exec(`UPDATE channels SET category_id = '' WHERE category_id = ?`, id); err != nil {
		return err
	}
	_, err := d.Exec(`DELETE FROM channel_categories WHERE id = ?`, id)
	return err
}

func (d *DB) ReorderCategories(orders []struct {
	ID       string
	Position int
}) error {
	tx, err := d.Begin()
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
