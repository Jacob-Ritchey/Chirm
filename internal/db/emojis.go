package db

// --- Custom Emojis ---

func (s *Store) CreateCustomEmoji(name, filename, uploaderID string) (*CustomEmoji, error) {
	id := NewID()
	// Fetch uploader username for denormalization.
	uploaderUsername := ""
	if u, err := s.GetUserByID(uploaderID); err == nil {
		uploaderUsername = u.Username
	}
	_, err := s.server.Exec(
		`INSERT INTO custom_emojis (id, name, filename, uploader_id, uploader_username) VALUES (?, ?, ?, ?, ?)`,
		id, name, filename, uploaderID, uploaderUsername)
	if err != nil {
		return nil, err
	}
	return s.GetCustomEmojiByID(id)
}

func (s *Store) GetCustomEmojiByID(id string) (*CustomEmoji, error) {
	e := &CustomEmoji{}
	err := s.server.QueryRow(
		`SELECT id, name, filename, uploader_id, uploader_username, created_at FROM custom_emojis WHERE id = ?`, id).
		Scan(&e.ID, &e.Name, &e.Filename, &e.UploaderID, &e.UploaderUsername, &e.CreatedAt)
	if err != nil {
		return nil, err
	}
	return e, nil
}

func (s *Store) ListCustomEmojis() ([]CustomEmoji, error) {
	rows, err := s.server.Query(`SELECT id, name, filename, uploader_id, uploader_username, created_at FROM custom_emojis ORDER BY name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var emojis []CustomEmoji
	for rows.Next() {
		var e CustomEmoji
		rows.Scan(&e.ID, &e.Name, &e.Filename, &e.UploaderID, &e.UploaderUsername, &e.CreatedAt)
		emojis = append(emojis, e)
	}
	if emojis == nil {
		emojis = []CustomEmoji{}
	}
	return emojis, nil
}

func (s *Store) DeleteCustomEmoji(id string) (string, error) {
	var filename string
	err := s.server.QueryRow(`SELECT filename FROM custom_emojis WHERE id = ?`, id).Scan(&filename)
	if err != nil {
		return "", err
	}
	_, err = s.server.Exec(`DELETE FROM custom_emojis WHERE id = ?`, id)
	return filename, err
}

func (s *Store) GetCustomEmojiByName(name string) (*CustomEmoji, error) {
	e := &CustomEmoji{}
	err := s.server.QueryRow(
		`SELECT id, name, filename, uploader_id, uploader_username, created_at FROM custom_emojis WHERE name = ?`, name).
		Scan(&e.ID, &e.Name, &e.Filename, &e.UploaderID, &e.UploaderUsername, &e.CreatedAt)
	if err != nil {
		return nil, err
	}
	return e, nil
}
