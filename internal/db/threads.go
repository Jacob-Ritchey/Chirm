package db

import (
	"database/sql"
	"time"
)

// --- Threads ---
//
// In the multi-DB architecture thread_id === thread_channel_id. A single NewID()
// is used for both the thread record and its companion channel record. The thread
// DB file is channels/{thread_id}.db, which is the same path as the thread channel.
//
// Write path for a thread message:
//   1. INSERT message       → channels/{thread_id}.db     (thread's own DB)
//   2. UPDATE thread        → channels/{thread_id}.db     (same file, free)
//   3. UPDATE thread_index  → channels/{parent_channel_id}.db (one lightweight UPDATE)

// CreateThread creates a thread, its companion channel record, its own DB file,
// and inserts the thread record and thread_index entry into the correct DBs.
func (s *Store) CreateThread(parentChannelID, name, creatorID string, sourceMessageID *string) (*Thread, error) {
	// thread_id === thread_channel_id
	threadID := NewID()

	creatorUsername := ""
	if u, err := s.GetUserByID(creatorID); err == nil {
		creatorUsername = u.Username
	}

	// 1. Register the thread as a channel in server.db (type='thread' hides it from ListChannels).
	if _, err := s.server.Exec(`INSERT INTO channels (id, name, type) VALUES (?, ?, 'thread')`, threadID, name); err != nil {
		return nil, err
	}

	// 2. Create the thread's own DB file and run migrations.
	tdb, err := s.channels.Create(threadID)
	if err != nil {
		s.server.Exec(`DELETE FROM channels WHERE id = ?`, threadID)
		return nil, err
	}

	// 3. Insert the full thread record into the thread's own DB.
	if _, err := tdb.Exec(
		`INSERT INTO thread (id, channel_id, thread_channel_id, name, creator_id, creator_username, source_message_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		threadID, parentChannelID, threadID, name, creatorID, creatorUsername, sourceMessageID,
	); err != nil {
		s.channels.Delete(threadID)
		s.server.Exec(`DELETE FROM channels WHERE id = ?`, threadID)
		return nil, err
	}

	// 4. Insert the thread_index entry into the parent channel's DB.
	pdb, err := s.channels.For(parentChannelID)
	if err != nil {
		s.channels.Delete(threadID)
		s.server.Exec(`DELETE FROM channels WHERE id = ?`, threadID)
		return nil, err
	}
	if _, err := pdb.Exec(
		`INSERT INTO thread_index (id, thread_channel_id, name, creator_username, source_message_id)
		 VALUES (?, ?, ?, ?, ?)`,
		threadID, threadID, name, creatorUsername, sourceMessageID,
	); err != nil {
		s.channels.Delete(threadID)
		s.server.Exec(`DELETE FROM channels WHERE id = ?`, threadID)
		return nil, err
	}

	return s.GetThreadByID(threadID)
}

// GetThreadByID reads the full thread record from the thread's own DB.
// Since thread_id === thread_channel_id, the DB path is channels/{id}.db.
func (s *Store) GetThreadByID(id string) (*Thread, error) {
	tdb, err := s.channels.For(id)
	if err != nil {
		return nil, err
	}
	return s.getThreadFromDB(tdb, id)
}

func (s *Store) getThreadFromDB(tdb *sql.DB, id string) (*Thread, error) {
	t := &Thread{}
	var creatorID, sourceMsgID sql.NullString
	err := tdb.QueryRow(
		`SELECT id, channel_id, thread_channel_id, name, creator_id, creator_username,
		        source_message_id, message_count, last_activity_at, created_at
		 FROM thread WHERE id = ?`, id,
	).Scan(&t.ID, &t.ChannelID, &t.ThreadChannelID, &t.Name, &creatorID,
		&t.CreatorUsername, &sourceMsgID, &t.MessageCount, &t.LastActivityAt, &t.CreatedAt)
	if err != nil {
		return nil, err
	}
	if creatorID.Valid {
		t.CreatorID = creatorID.String
	}
	if sourceMsgID.Valid {
		t.SourceMessageID = &sourceMsgID.String
	}
	return t, nil
}

// GetThreadByChannelID is equivalent to GetThreadByID since thread_id === thread_channel_id.
func (s *Store) GetThreadByChannelID(threadChannelID string) (*Thread, error) {
	return s.GetThreadByID(threadChannelID)
}

// CountThreadsByChannel returns the total number of threads in a channel.
func (s *Store) CountThreadsByChannel(channelID string) (int, error) {
	pdb, err := s.channels.For(channelID)
	if err != nil {
		return 0, err
	}
	var count int
	err = pdb.QueryRow(`SELECT COUNT(*) FROM thread_index`).Scan(&count)
	return count, err
}

// ListThreadsByChannelPaged returns threads for a given page (1-indexed), ordered by
// creation time ascending (oldest = page 1) then reversed so newest of the batch
// appears first in the returned slice. Used by forum/gallery channel views.
func (s *Store) ListThreadsByChannelPaged(channelID string, page, pageSize int) ([]Thread, error) {
	pdb, err := s.channels.For(channelID)
	if err != nil {
		return nil, err
	}
	offset := (page - 1) * pageSize
	rows, err := pdb.Query(
		`SELECT id, thread_channel_id, name, creator_username, source_message_id,
		        message_count, last_activity_at, created_at
		 FROM thread_index
		 ORDER BY created_at ASC
		 LIMIT ? OFFSET ?`, pageSize, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var threads []Thread
	for rows.Next() {
		var t Thread
		var sourceMsgID sql.NullString
		rows.Scan(&t.ID, &t.ThreadChannelID, &t.Name, &t.CreatorUsername, &sourceMsgID,
			&t.MessageCount, &t.LastActivityAt, &t.CreatedAt)
		t.ChannelID = channelID
		if sourceMsgID.Valid {
			t.SourceMessageID = &sourceMsgID.String
		}
		threads = append(threads, t)
	}
	// Reverse so newest-created of the batch appears first.
	for i, j := 0, len(threads)-1; i < j; i, j = i+1, j-1 {
		threads[i], threads[j] = threads[j], threads[i]
	}
	return threads, nil
}

// ListThreadsByChannel returns threads in a parent channel ordered by last activity,
// reading from the parent channel's thread_index table.
func (s *Store) ListThreadsByChannel(channelID string, before string, limit int) ([]Thread, error) {
	pdb, err := s.channels.For(channelID)
	if err != nil {
		return nil, err
	}

	var rows *sql.Rows
	if before == "" {
		rows, err = pdb.Query(
			`SELECT id, thread_channel_id, name, creator_username, source_message_id,
			        message_count, last_activity_at, created_at
			 FROM thread_index ORDER BY last_activity_at DESC LIMIT ?`, limit)
	} else {
		rows, err = pdb.Query(
			`SELECT id, thread_channel_id, name, creator_username, source_message_id,
			        message_count, last_activity_at, created_at
			 FROM thread_index
			 WHERE last_activity_at < (SELECT last_activity_at FROM thread_index WHERE id = ?)
			 ORDER BY last_activity_at DESC LIMIT ?`, before, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var threads []Thread
	for rows.Next() {
		var t Thread
		var sourceMsgID sql.NullString
		rows.Scan(&t.ID, &t.ThreadChannelID, &t.Name, &t.CreatorUsername, &sourceMsgID,
			&t.MessageCount, &t.LastActivityAt, &t.CreatedAt)
		t.ChannelID = channelID
		if sourceMsgID.Valid {
			t.SourceMessageID = &sourceMsgID.String
		}
		threads = append(threads, t)
	}
	return threads, nil
}

// DeleteThread removes the thread from all three locations:
// thread_index in parent channel DB, thread record in thread's own DB,
// the channels record in server.db, and the thread's DB file itself.
func (s *Store) DeleteThread(threadID string) error {
	// Get thread to find parent channel ID.
	t, err := s.GetThreadByID(threadID)
	if err != nil {
		return err
	}

	// Remove thread_index from parent channel DB.
	if pdb, err := s.channels.For(t.ChannelID); err == nil {
		pdb.Exec(`DELETE FROM thread_index WHERE id = ?`, threadID)
	}

	// Remove channel record from server.db.
	s.server.Exec(`DELETE FROM channels WHERE id = ?`, threadID)

	// Delete thread's own DB file (closes handle + removes file).
	return s.channels.Delete(threadID)
}

// IncrementThreadMessageCount updates message_count and last_activity_at in both
// the thread's own DB (thread table) and the parent channel's DB (thread_index).
func (s *Store) IncrementThreadMessageCount(threadID, parentChannelID string) error {
	now := time.Now()

	tdb, err := s.channels.For(threadID)
	if err != nil {
		return err
	}
	if _, err := tdb.Exec(
		`UPDATE thread SET message_count = message_count + 1, last_activity_at = ? WHERE id = ?`,
		now, threadID,
	); err != nil {
		return err
	}

	if pdb, err := s.channels.For(parentChannelID); err == nil {
		pdb.Exec(
			`UPDATE thread_index SET message_count = message_count + 1, last_activity_at = ? WHERE id = ?`,
			now, threadID,
		)
	}
	return nil
}

// DecrementThreadMessageCount decrements message_count in the thread's own DB.
// (thread_index count drifts and is reconciled by IncrementThreadMessageCount.)
func (s *Store) DecrementThreadMessageCount(threadID string) error {
	tdb, err := s.channels.For(threadID)
	if err != nil {
		return err
	}
	_, err = tdb.Exec(
		`UPDATE thread SET message_count = MAX(0, message_count - 1) WHERE id = ?`, threadID)
	return err
}

// GetThreadFirstMessage returns the first (oldest) message in a thread's own channel.
// Used for forum/gallery post card previews.
func (s *Store) GetThreadFirstMessage(threadID string) (*Message, error) {
	tdb, err := s.channels.For(threadID)
	if err != nil {
		return nil, err
	}
	var msgID string
	err = tdb.QueryRow(
		`SELECT id FROM messages WHERE channel_id = ? ORDER BY created_at ASC LIMIT 1`,
		threadID,
	).Scan(&msgID)
	if err != nil {
		return nil, err
	}
	return s.getMessageFromDB(tdb, msgID, threadID)
}
