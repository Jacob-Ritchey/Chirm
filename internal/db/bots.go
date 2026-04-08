package db

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

// NewBotToken generates a unique bot token in the form chirm_bot_<32-hex-chars>.
func NewBotToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return fmt.Sprintf("chirm_bot_%s", hex.EncodeToString(b)), nil
}

func (s *Store) CreateBot(name string, permissions int) (*Bot, error) {
	id := NewID()
	token, err := NewBotToken()
	if err != nil {
		return nil, err
	}
	_, err = s.server.Exec(`INSERT INTO bots (id, name, token, permissions) VALUES (?, ?, ?, ?)`,
		id, name, token, permissions)
	if err != nil {
		return nil, err
	}
	return s.GetBotByToken(token)
}

func (s *Store) GetBotByID(id string) (*Bot, error) {
	b := &Bot{}
	err := s.server.QueryRow(`SELECT id, name, permissions, created_at FROM bots WHERE id = ?`, id).
		Scan(&b.ID, &b.Name, &b.Permissions, &b.CreatedAt)
	if err != nil {
		return nil, err
	}
	return b, nil
}

// GetBotByToken is the only function that selects the token column.
func (s *Store) GetBotByToken(token string) (*Bot, error) {
	b := &Bot{}
	err := s.server.QueryRow(`SELECT id, name, token, permissions, created_at FROM bots WHERE token = ?`, token).
		Scan(&b.ID, &b.Name, &b.Token, &b.Permissions, &b.CreatedAt)
	if err != nil {
		return nil, err
	}
	return b, nil
}

func (s *Store) ListBots() ([]Bot, error) {
	rows, err := s.server.Query(`SELECT id, name, permissions, created_at FROM bots ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var bots []Bot
	for rows.Next() {
		var b Bot
		rows.Scan(&b.ID, &b.Name, &b.Permissions, &b.CreatedAt)
		bots = append(bots, b)
	}
	return bots, nil
}

func (s *Store) UpdateBot(id, name string, permissions int) error {
	_, err := s.server.Exec(`UPDATE bots SET name = ?, permissions = ? WHERE id = ?`, name, permissions, id)
	return err
}

func (s *Store) DeleteBot(id string) error {
	_, err := s.server.Exec(`DELETE FROM bots WHERE id = ?`, id)
	return err
}

func (s *Store) RegenerateBotToken(id string) (*Bot, error) {
	token, err := NewBotToken()
	if err != nil {
		return nil, err
	}
	_, err = s.server.Exec(`UPDATE bots SET token = ? WHERE id = ?`, token, id)
	if err != nil {
		return nil, err
	}
	return s.GetBotByToken(token)
}
