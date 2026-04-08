package db

import (
	"database/sql"
	"time"
)

// --- Threads ---

func (d *DB) CreateThread(channelID, name, creatorID string, sourceMessageID *string) (*Thread, error) {
	id := NewID()
	_, err := d.Exec(
		`INSERT INTO threads (id, channel_id, name, creator_id, source_message_id) VALUES (?, ?, ?, ?, ?)`,
		id, channelID, name, creatorID, sourceMessageID,
	)
	if err != nil {
		return nil, err
	}

	// Create a companion hidden channel for this thread (type='thread' hides it from ListChannels).
	chID := NewID()
	if _, err := d.Exec(`INSERT INTO channels (id, name, type) VALUES (?, ?, 'thread')`, chID, name); err != nil {
		return nil, err
	}
	if _, err := d.Exec(`UPDATE threads SET thread_channel_id = ? WHERE id = ?`, chID, id); err != nil {
		return nil, err
	}

	return d.GetThreadByID(id)
}

func (d *DB) GetThreadByID(id string) (*Thread, error) {
	t := &Thread{}
	var creatorID sql.NullString
	var sourceMsgID sql.NullString
	var threadChannelID sql.NullString
	err := d.QueryRow(
		`SELECT id, channel_id, COALESCE(thread_channel_id,''), name, creator_id, source_message_id, message_count, last_activity_at, created_at
		 FROM threads WHERE id = ?`, id,
	).Scan(&t.ID, &t.ChannelID, &t.ThreadChannelID, &t.Name, &creatorID, &sourceMsgID, &t.MessageCount, &t.LastActivityAt, &t.CreatedAt)
	if err != nil {
		return nil, err
	}
	_ = threadChannelID
	if creatorID.Valid {
		t.CreatorID = creatorID.String
		t.Creator, _ = d.GetUserByID(creatorID.String)
	}
	if sourceMsgID.Valid {
		t.SourceMessageID = &sourceMsgID.String
	}
	return t, nil
}

// GetThreadByChannelID looks up a thread by its companion thread_channel_id.
// Used by SendMessage to detect when a message is sent to a thread channel.
func (d *DB) GetThreadByChannelID(threadChannelID string) (*Thread, error) {
	t := &Thread{}
	var creatorID sql.NullString
	var sourceMsgID sql.NullString
	err := d.QueryRow(
		`SELECT id, channel_id, COALESCE(thread_channel_id,''), name, creator_id, source_message_id, message_count, last_activity_at, created_at
		 FROM threads WHERE thread_channel_id = ?`, threadChannelID,
	).Scan(&t.ID, &t.ChannelID, &t.ThreadChannelID, &t.Name, &creatorID, &sourceMsgID, &t.MessageCount, &t.LastActivityAt, &t.CreatedAt)
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

func (d *DB) ListThreadsByChannel(channelID string, before string, limit int) ([]Thread, error) {
	var rows *sql.Rows
	var err error
	if before == "" {
		rows, err = d.Query(
			`SELECT id, channel_id, COALESCE(thread_channel_id,''), name, creator_id, source_message_id, message_count, last_activity_at, created_at
			 FROM threads WHERE channel_id = ?
			 ORDER BY last_activity_at DESC LIMIT ?`,
			channelID, limit,
		)
	} else {
		rows, err = d.Query(
			`SELECT id, channel_id, COALESCE(thread_channel_id,''), name, creator_id, source_message_id, message_count, last_activity_at, created_at
			 FROM threads WHERE channel_id = ?
			   AND last_activity_at < (SELECT last_activity_at FROM threads WHERE id = ?)
			 ORDER BY last_activity_at DESC LIMIT ?`,
			channelID, before, limit,
		)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var threads []Thread
	for rows.Next() {
		var t Thread
		var creatorID sql.NullString
		var sourceMsgID sql.NullString
		rows.Scan(&t.ID, &t.ChannelID, &t.ThreadChannelID, &t.Name, &creatorID, &sourceMsgID, &t.MessageCount, &t.LastActivityAt, &t.CreatedAt)
		if creatorID.Valid {
			t.CreatorID = creatorID.String
			t.Creator, _ = d.GetUserByID(creatorID.String)
		}
		if sourceMsgID.Valid {
			t.SourceMessageID = &sourceMsgID.String
		}
		threads = append(threads, t)
	}
	return threads, nil
}

func (d *DB) DeleteThread(id string) error {
	_, err := d.Exec(`DELETE FROM threads WHERE id = ?`, id)
	return err
}

func (d *DB) IncrementThreadMessageCount(threadID string) error {
	_, err := d.Exec(
		`UPDATE threads SET message_count = message_count + 1, last_activity_at = ? WHERE id = ?`,
		time.Now(), threadID,
	)
	return err
}

func (d *DB) DecrementThreadMessageCount(threadID string) error {
	_, err := d.Exec(
		`UPDATE threads SET message_count = MAX(0, message_count - 1) WHERE id = ?`,
		threadID,
	)
	return err
}

// GetThreadFirstMessage returns the first (oldest) message in a thread's channel.
// Used for forum/gallery post card previews.
func (d *DB) GetThreadFirstMessage(threadID string) (*Message, error) {
	thread, err := d.GetThreadByID(threadID)
	if err != nil {
		return nil, err
	}
	if thread.ThreadChannelID == "" {
		// Fallback: legacy thread_id-based lookup
		var msgID string
		err = d.QueryRow(
			`SELECT id FROM messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT 1`,
			threadID,
		).Scan(&msgID)
		if err != nil {
			return nil, err
		}
		return d.GetMessageByID(msgID)
	}
	// New architecture: first message in the thread's own channel
	var msgID string
	err = d.QueryRow(
		`SELECT id FROM messages WHERE channel_id = ? ORDER BY created_at ASC LIMIT 1`,
		thread.ThreadChannelID,
	).Scan(&msgID)
	if err != nil {
		return nil, err
	}
	return d.GetMessageByID(msgID)
}

// GetThreadRefForMessage returns a ThreadRef if the given message is the
// source_message_id of any thread. Used to populate msg.Thread in GetMessageByID.
func (d *DB) GetThreadRefForMessage(messageID string) (*ThreadRef, error) {
	ref := &ThreadRef{}
	err := d.QueryRow(
		`SELECT id, name, message_count FROM threads WHERE source_message_id = ? LIMIT 1`,
		messageID,
	).Scan(&ref.ID, &ref.Name, &ref.MessageCount)
	if err != nil {
		return nil, err
	}
	return ref, nil
}
