package db

import (
	"encoding/json"
	"fmt"
)

// ─── Push Subscriptions ───────────────────────────────────────────────────────

func (s *Store) SavePushSubscription(userID, data string) error {
	var sub struct {
		Endpoint string `json:"endpoint"`
	}
	if err := json.Unmarshal([]byte(data), &sub); err != nil || sub.Endpoint == "" {
		return fmt.Errorf("invalid subscription data")
	}
	_, _ = s.members.Exec(`DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?`, userID, sub.Endpoint)
	id := NewID()
	_, err := s.members.Exec(`
		INSERT INTO push_subscriptions (id, user_id, endpoint, data)
		VALUES (?, ?, ?, ?)`,
		id, userID, sub.Endpoint, data)
	return err
}

func (s *Store) DeletePushSubscription(userID, endpoint string) error {
	_, err := s.members.Exec(`DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?`, userID, endpoint)
	return err
}

// GetAllPushSubscriptions returns all push subscriptions for all users.
func (s *Store) GetAllPushSubscriptions() ([]PushSubscription, error) {
	rows, err := s.members.Query(`SELECT id, user_id, endpoint, data FROM push_subscriptions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var subs []PushSubscription
	for rows.Next() {
		var sub PushSubscription
		if err := rows.Scan(&sub.ID, &sub.UserID, &sub.Endpoint, &sub.Data); err == nil {
			subs = append(subs, sub)
		}
	}
	return subs, rows.Err()
}
