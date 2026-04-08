package db

// PropagateProfileUpdate updates the denormalized author_username and
// author_avatar fields across all channel DBs when a user changes their
// profile. Called after UpdateUserProfile / UpdateUser / UploadAvatar.
func (s *Store) PropagateProfileUpdate(userID, newUsername, newAvatar string) error {
	for _, cdb := range s.channels.All() {
		cdb.Exec(
			`UPDATE messages SET author_username = ?, author_avatar = ? WHERE user_id = ?`,
			newUsername, newAvatar, userID,
		)
		// Also update creator_username in thread records and thread_index entries.
		cdb.Exec(
			`UPDATE thread SET creator_username = ? WHERE creator_id = ?`,
			newUsername, userID,
		)
		cdb.Exec(
			`UPDATE thread_index SET creator_username = ? WHERE id IN (
			     SELECT id FROM thread WHERE creator_id = ?
			 )`,
			newUsername, userID,
		)
	}
	// Update creator_username in invites.
	s.server.Exec(
		`UPDATE invites SET creator_username = ? WHERE created_by = ?`,
		newUsername, userID,
	)
	// Update uploader_username in custom_emojis.
	s.server.Exec(
		`UPDATE custom_emojis SET uploader_username = ? WHERE uploader_id = ?`,
		newUsername, userID,
	)
	return nil
}

// PropagateBotRename updates the denormalized bot_name field across all channel
// DBs when a bot is renamed. Called after UpdateBot.
func (s *Store) PropagateBotRename(botID, newName string) error {
	for _, cdb := range s.channels.All() {
		cdb.Exec(
			`UPDATE messages SET bot_name = ? WHERE bot_id = ?`,
			newName, botID,
		)
	}
	return nil
}

// ReconcileAllStorageUsed recomputes storage counters for all users by summing
// attachment sizes across all channel DBs. Called by the background hourly job.
func (s *Store) ReconcileAllStorageUsed() {
	// Aggregate attachment sizes per user across all channel DBs.
	totals := map[string]int64{}
	for _, cdb := range s.channels.All() {
		rows, err := cdb.Query(`
			SELECT m.user_id, SUM(a.size)
			FROM attachments a
			JOIN messages m ON a.message_id = m.id
			WHERE m.user_id IS NOT NULL AND m.user_id != ''
			GROUP BY m.user_id
		`)
		if err != nil {
			continue
		}
		for rows.Next() {
			var uid string
			var sum int64
			if rows.Scan(&uid, &sum) == nil {
				totals[uid] += sum
			}
		}
		rows.Close()
	}

	for uid, total := range totals {
		s.members.Exec(`UPDATE users SET storage_used_bytes = ? WHERE id = ?`, total, uid)
	}
}
