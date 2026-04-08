package db

// --- Server Settings ---

func (s *Store) IsSetupDone() bool {
	var val string
	err := s.server.QueryRow(`SELECT value FROM server_settings WHERE key = 'setup_done'`).Scan(&val)
	return err == nil && val == "1"
}

func (s *Store) SetSetting(key, value string) error {
	_, err := s.server.Exec(`INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)`, key, value)
	return err
}

func (s *Store) GetSetting(key string) (string, error) {
	var val string
	err := s.server.QueryRow(`SELECT value FROM server_settings WHERE key = ?`, key).Scan(&val)
	return val, err
}

func (s *Store) GetAllSettings() (map[string]string, error) {
	rows, err := s.server.Query(`SELECT key, value FROM server_settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := make(map[string]string)
	for rows.Next() {
		var k, v string
		rows.Scan(&k, &v)
		m[k] = v
	}
	return m, nil
}
