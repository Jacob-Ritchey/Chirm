package db

import (
	"encoding/json"
	"fmt"
)

// ─── Push Subscriptions ───────────────────────────────────────────────────────

func (d *DB) SavePushSubscription(userID, data string) error {
	// Parse endpoint from data JSON to use as dedup key
	var sub struct {
		Endpoint string `json:"endpoint"`
	}
	if err := json.Unmarshal([]byte(data), &sub); err != nil || sub.Endpoint == "" {
		return fmt.Errorf("invalid subscription data")
	}
	// Remove any existing subscription this user has for the same endpoint.
	_, _ = d.Exec(`DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?`, userID, sub.Endpoint)
	id := NewID()
	_, err := d.Exec(`
		INSERT INTO push_subscriptions (id, user_id, endpoint, data)
		VALUES (?, ?, ?, ?)`,
		id, userID, sub.Endpoint, data)
	return err
}

func (d *DB) DeletePushSubscription(userID, endpoint string) error {
	_, err := d.Exec(`DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?`, userID, endpoint)
	return err
}

// GetAllPushSubscriptions returns all push subscriptions for all users.
func (d *DB) GetAllPushSubscriptions() ([]PushSubscription, error) {
	rows, err := d.Query(`SELECT id, user_id, endpoint, data FROM push_subscriptions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var subs []PushSubscription
	for rows.Next() {
		var s PushSubscription
		if err := rows.Scan(&s.ID, &s.UserID, &s.Endpoint, &s.Data); err == nil {
			subs = append(subs, s)
		}
	}
	return subs, rows.Err()
}
