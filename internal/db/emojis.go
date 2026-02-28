package db

// --- Custom Emojis ---

func (d *DB) CreateCustomEmoji(name, filename, uploaderID string) (*CustomEmoji, error) {
	id := NewID()
	_, err := d.Exec(`INSERT INTO custom_emojis (id, name, filename, uploader_id) VALUES (?, ?, ?, ?)`,
		id, name, filename, uploaderID)
	if err != nil {
		return nil, err
	}
	return d.GetCustomEmojiByID(id)
}

func (d *DB) GetCustomEmojiByID(id string) (*CustomEmoji, error) {
	e := &CustomEmoji{}
	err := d.QueryRow(`SELECT id, name, filename, uploader_id, created_at FROM custom_emojis WHERE id = ?`, id).
		Scan(&e.ID, &e.Name, &e.Filename, &e.UploaderID, &e.CreatedAt)
	if err != nil {
		return nil, err
	}
	e.Uploader, _ = d.GetUserByID(e.UploaderID)
	return e, nil
}

func (d *DB) ListCustomEmojis() ([]CustomEmoji, error) {
	rows, err := d.Query(`SELECT id, name, filename, uploader_id, created_at FROM custom_emojis ORDER BY name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var emojis []CustomEmoji
	for rows.Next() {
		var e CustomEmoji
		rows.Scan(&e.ID, &e.Name, &e.Filename, &e.UploaderID, &e.CreatedAt)
		e.Uploader, _ = d.GetUserByID(e.UploaderID)
		emojis = append(emojis, e)
	}
	if emojis == nil {
		emojis = []CustomEmoji{}
	}
	return emojis, nil
}

func (d *DB) DeleteCustomEmoji(id string) (string, error) {
	var filename string
	err := d.QueryRow(`SELECT filename FROM custom_emojis WHERE id = ?`, id).Scan(&filename)
	if err != nil {
		return "", err
	}
	_, err = d.Exec(`DELETE FROM custom_emojis WHERE id = ?`, id)
	return filename, err
}

func (d *DB) GetCustomEmojiByName(name string) (*CustomEmoji, error) {
	e := &CustomEmoji{}
	err := d.QueryRow(`SELECT id, name, filename, uploader_id, created_at FROM custom_emojis WHERE name = ?`, name).
		Scan(&e.ID, &e.Name, &e.Filename, &e.UploaderID, &e.CreatedAt)
	if err != nil {
		return nil, err
	}
	return e, nil
}
