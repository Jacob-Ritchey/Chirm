package db

import (
	"database/sql"
	"time"
)

// --- Messages ---

// CreateMessage inserts a new user message into the given channel's DB.
func (s *Store) CreateMessage(channelID, userID, content string, replyToID *string) (*Message, error) {
	u, _ := s.GetUserByID(userID)
	authorUsername, authorAvatar := "", ""
	if u != nil {
		authorUsername = u.Username
		authorAvatar = u.Avatar
	}

	cdb, err := s.channels.For(channelID)
	if err != nil {
		return nil, err
	}
	id := NewID()
	_, err = cdb.Exec(
		`INSERT INTO messages (id, channel_id, user_id, author_username, author_avatar, content, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, channelID, userID, authorUsername, authorAvatar, content, replyToID)
	if err != nil {
		return nil, err
	}
	// Register in routing table so REST endpoints can find the message by ID alone.
	s.server.Exec(`INSERT OR IGNORE INTO message_routes (message_id, channel_id) VALUES (?, ?)`, id, channelID)
	return s.getMessageFromDB(cdb, id, channelID)
}

// CreateMessageFromBot inserts a new bot message into the given channel's DB.
func (s *Store) CreateMessageFromBot(channelID, botID, content string, replyToID *string) (*Message, error) {
	botName := ""
	if b, err := s.GetBotByID(botID); err == nil {
		botName = b.Name
	}

	cdb, err := s.channels.For(channelID)
	if err != nil {
		return nil, err
	}
	id := NewID()
	_, err = cdb.Exec(
		`INSERT INTO messages (id, channel_id, bot_id, bot_name, content, reply_to_id) VALUES (?, ?, ?, ?, ?, ?)`,
		id, channelID, botID, botName, content, replyToID)
	if err != nil {
		return nil, err
	}
	s.server.Exec(`INSERT OR IGNORE INTO message_routes (message_id, channel_id) VALUES (?, ?)`, id, channelID)
	return s.getMessageFromDB(cdb, id, channelID)
}

// CreateThreadMessage inserts a message that belongs to a thread (legacy path).
// Prefer CreateMessage with the thread's own channel ID in the new architecture.
func (s *Store) CreateThreadMessage(threadID, channelID, userID, content string, replyToID *string) (*Message, error) {
	u, _ := s.GetUserByID(userID)
	authorUsername, authorAvatar := "", ""
	if u != nil {
		authorUsername = u.Username
		authorAvatar = u.Avatar
	}

	cdb, err := s.channels.For(channelID)
	if err != nil {
		return nil, err
	}
	id := NewID()
	_, err = cdb.Exec(
		`INSERT INTO messages (id, channel_id, thread_id, user_id, author_username, author_avatar, content, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, channelID, threadID, userID, authorUsername, authorAvatar, content, replyToID)
	if err != nil {
		return nil, err
	}
	s.server.Exec(`INSERT OR IGNORE INTO message_routes (message_id, channel_id) VALUES (?, ?)`, id, channelID)
	return s.getMessageFromDB(cdb, id, channelID)
}

// GetMessageByID looks up a message by ID, using the message_routes table to
// find which channel DB it lives in.
func (s *Store) GetMessageByID(id string) (*Message, error) {
	var channelID string
	err := s.server.QueryRow(`SELECT channel_id FROM message_routes WHERE message_id = ?`, id).Scan(&channelID)
	if err != nil {
		return nil, err
	}
	cdb, err := s.channels.For(channelID)
	if err != nil {
		return nil, err
	}
	return s.getMessageFromDB(cdb, id, channelID)
}

// getMessageFromDB reads a single message from a known channel DB and populates
// all related fields (reply, thread ref, attachments, reactions, author).
func (s *Store) getMessageFromDB(cdb *sql.DB, id, channelID string) (*Message, error) {
	m := &Message{}
	var editedAt sql.NullTime
	var replyToID, threadID, userID, botID sql.NullString
	err := cdb.QueryRow(`
		SELECT id, channel_id, user_id, bot_id, author_username, author_avatar, bot_name,
		       content, reply_to_id, thread_id, edited_at, created_at
		FROM messages WHERE id = ?`, id).
		Scan(&m.ID, &m.ChannelID, &userID, &botID, &m.AuthorUsername, &m.AuthorAvatar, &m.BotName,
			&m.Content, &replyToID, &threadID, &editedAt, &m.CreatedAt)
	if err != nil {
		return nil, err
	}
	if userID.Valid {
		m.UserID = userID.String
	}
	if botID.Valid {
		m.BotID = &botID.String
	}
	if editedAt.Valid {
		m.EditedAt = &editedAt.Time
	}
	if replyToID.Valid {
		m.ReplyToID = &replyToID.String
		m.ReplyTo, _ = s.getMessageRefFromDB(cdb, replyToID.String)
	}
	if threadID.Valid {
		m.ThreadID = &threadID.String
	}

	// Populate Author/Bot from denormalized fields for the JSON response.
	if m.UserID != "" {
		m.Author = &User{ID: m.UserID, Username: m.AuthorUsername, Avatar: m.AuthorAvatar}
	}
	if m.BotID != nil {
		m.Bot = &Bot{ID: *m.BotID, Name: m.BotName}
	}

	m.Attachments, _ = s.getAttachmentsFromDB(cdb, m.ID)
	m.Reactions, _ = s.getReactionsFromDB(cdb, m.ID)

	// If this message is the source of a thread, attach a ThreadRef.
	if m.ThreadID == nil {
		m.Thread, _ = s.getThreadRefForMessageFromDB(cdb, m.ID)
	}
	return m, nil
}

func (s *Store) GetMessageRef(id, channelID string) (*MessageRef, error) {
	cdb, err := s.channels.For(channelID)
	if err != nil {
		return nil, err
	}
	return s.getMessageRefFromDB(cdb, id)
}

func (s *Store) getMessageRefFromDB(cdb *sql.DB, id string) (*MessageRef, error) {
	ref := &MessageRef{ID: id}
	var authorUsername sql.NullString
	err := cdb.QueryRow(`SELECT content, author_username FROM messages WHERE id = ?`, id).
		Scan(&ref.Content, &authorUsername)
	if err != nil {
		return nil, err
	}
	if authorUsername.Valid && authorUsername.String != "" {
		ref.AuthorName = authorUsername.String
	} else {
		ref.AuthorName = "Deleted User"
	}
	if len(ref.Content) > 100 {
		ref.Content = ref.Content[:97] + "..."
	}
	return ref, nil
}

func (s *Store) GetMessages(channelID string, before string, limit int) ([]Message, error) {
	cdb, err := s.channels.For(channelID)
	if err != nil {
		return nil, err
	}

	var rows *sql.Rows
	if before == "" {
		rows, err = cdb.Query(`
			SELECT id, channel_id, user_id, bot_id, author_username, author_avatar, bot_name,
			       content, reply_to_id, edited_at, created_at
			FROM messages WHERE channel_id = ? AND thread_id IS NULL
			ORDER BY created_at DESC LIMIT ?`, channelID, limit)
	} else {
		rows, err = cdb.Query(`
			SELECT id, channel_id, user_id, bot_id, author_username, author_avatar, bot_name,
			       content, reply_to_id, edited_at, created_at
			FROM messages WHERE channel_id = ? AND thread_id IS NULL
			  AND created_at < (SELECT created_at FROM messages WHERE id = ?)
			ORDER BY created_at DESC LIMIT ?`, channelID, before, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []Message
	for rows.Next() {
		var m Message
		var editedAt sql.NullTime
		var replyToID, userID, botID sql.NullString
		rows.Scan(&m.ID, &m.ChannelID, &userID, &botID, &m.AuthorUsername, &m.AuthorAvatar, &m.BotName,
			&m.Content, &replyToID, &editedAt, &m.CreatedAt)
		if userID.Valid {
			m.UserID = userID.String
		}
		if botID.Valid {
			m.BotID = &botID.String
		}
		if editedAt.Valid {
			m.EditedAt = &editedAt.Time
		}
		if replyToID.Valid {
			m.ReplyToID = &replyToID.String
			m.ReplyTo, _ = s.getMessageRefFromDB(cdb, replyToID.String)
		}
		if m.UserID != "" {
			m.Author = &User{ID: m.UserID, Username: m.AuthorUsername, Avatar: m.AuthorAvatar}
		}
		if m.BotID != nil {
			m.Bot = &Bot{ID: *m.BotID, Name: m.BotName}
		}
		m.Attachments, _ = s.getAttachmentsFromDB(cdb, m.ID)
		m.Reactions, _ = s.getReactionsFromDB(cdb, m.ID)
		m.Thread, _ = s.getThreadRefForMessageFromDB(cdb, m.ID)
		msgs = append(msgs, m)
	}
	// Reverse so oldest first.
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	return msgs, nil
}

// GetThreadMessages returns paginated messages belonging to a thread (legacy).
// In the new architecture, use GetMessages(thread.ThreadChannelID, ...).
func (s *Store) GetThreadMessages(threadID string, before string, limit int) ([]Message, error) {
	// Legacy: thread messages stored with thread_id in any channel DB.
	// Route via thread ID to find the thread channel.
	return s.GetMessages(threadID, before, limit)
}

func (s *Store) EditMessage(id, content string) error {
	var channelID string
	if err := s.server.QueryRow(`SELECT channel_id FROM message_routes WHERE message_id = ?`, id).Scan(&channelID); err != nil {
		return err
	}
	cdb, err := s.channels.For(channelID)
	if err != nil {
		return err
	}
	now := time.Now()
	_, err = cdb.Exec(`UPDATE messages SET content = ?, edited_at = ? WHERE id = ?`, content, now, id)
	return err
}

func (s *Store) DeleteMessage(id string) error {
	var channelID string
	if err := s.server.QueryRow(`SELECT channel_id FROM message_routes WHERE message_id = ?`, id).Scan(&channelID); err != nil {
		return err
	}
	cdb, err := s.channels.For(channelID)
	if err != nil {
		return err
	}
	_, err = cdb.Exec(`DELETE FROM messages WHERE id = ?`, id)
	if err != nil {
		return err
	}
	s.server.Exec(`DELETE FROM message_routes WHERE message_id = ?`, id)
	return nil
}

// --- Attachments ---

// CreateAttachment stores an uploaded file as a pending attachment in server.db
// until it is linked to a message via LinkAttachment.
func (s *Store) CreateAttachment(userID, filename, originalName, mimeType string, size int64) (*Attachment, error) {
	id := NewID()
	_, err := s.server.Exec(
		`INSERT INTO pending_attachments (id, user_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?, ?)`,
		id, userID, filename, originalName, mimeType, size)
	if err != nil {
		return nil, err
	}
	a := &Attachment{ID: id, Filename: filename, OriginalName: originalName, MimeType: mimeType, Size: size}
	return a, nil
}

// LinkAttachment moves a pending attachment into the channel's DB and links it
// to the given message.
func (s *Store) LinkAttachment(attachmentID, messageID, channelID string) error {
	var filename, originalName, mimeType string
	var size int64
	err := s.server.QueryRow(
		`SELECT filename, original_name, mime_type, size FROM pending_attachments WHERE id = ?`, attachmentID).
		Scan(&filename, &originalName, &mimeType, &size)
	if err != nil {
		// Not found in pending — may already be linked; ignore.
		return nil
	}

	cdb, err := s.channels.For(channelID)
	if err != nil {
		return err
	}
	_, err = cdb.Exec(
		`INSERT OR IGNORE INTO attachments (id, message_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?, ?)`,
		attachmentID, messageID, filename, originalName, mimeType, size)
	if err != nil {
		return err
	}
	s.server.Exec(`DELETE FROM pending_attachments WHERE id = ?`, attachmentID)
	return nil
}

func (s *Store) GetAttachments(messageID, channelID string) ([]Attachment, error) {
	cdb, err := s.channels.For(channelID)
	if err != nil {
		return nil, err
	}
	return s.getAttachmentsFromDB(cdb, messageID)
}

func (s *Store) getAttachmentsFromDB(cdb *sql.DB, messageID string) ([]Attachment, error) {
	rows, err := cdb.Query(`SELECT id, message_id, filename, original_name, mime_type, size, created_at FROM attachments WHERE message_id = ?`, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var atts []Attachment
	for rows.Next() {
		var a Attachment
		rows.Scan(&a.ID, &a.MessageID, &a.Filename, &a.OriginalName, &a.MimeType, &a.Size, &a.CreatedAt)
		atts = append(atts, a)
	}
	return atts, nil
}

// --- Reactions ---

func (s *Store) AddReaction(messageID, channelID, userID, emoji string) error {
	cdb, err := s.channels.For(channelID)
	if err != nil {
		return err
	}
	_, err = cdb.Exec(`INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)`,
		messageID, userID, emoji)
	return err
}

func (s *Store) RemoveReaction(messageID, channelID, userID, emoji string) error {
	cdb, err := s.channels.For(channelID)
	if err != nil {
		return err
	}
	_, err = cdb.Exec(`DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
		messageID, userID, emoji)
	return err
}

func (s *Store) GetReactions(messageID, channelID string) ([]Reaction, error) {
	cdb, err := s.channels.For(channelID)
	if err != nil {
		return nil, err
	}
	return s.getReactionsFromDB(cdb, messageID)
}

func (s *Store) getReactionsFromDB(cdb *sql.DB, messageID string) ([]Reaction, error) {
	rows, err := cdb.Query(`SELECT emoji, user_id FROM reactions WHERE message_id = ? ORDER BY emoji, created_at`, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byEmoji := map[string]*Reaction{}
	order := []string{}
	for rows.Next() {
		var emoji, userID string
		rows.Scan(&emoji, &userID)
		if _, ok := byEmoji[emoji]; !ok {
			byEmoji[emoji] = &Reaction{Emoji: emoji}
			order = append(order, emoji)
		}
		byEmoji[emoji].Count++
		byEmoji[emoji].UserIDs = append(byEmoji[emoji].UserIDs, userID)
	}
	result := make([]Reaction, 0, len(order))
	for _, e := range order {
		result = append(result, *byEmoji[e])
	}
	return result, nil
}

// getThreadRefForMessageFromDB looks for a thread_index entry where the given
// message is the source_message_id. Called from getMessageFromDB to populate
// the thread chip on channel messages.
func (s *Store) getThreadRefForMessageFromDB(cdb *sql.DB, messageID string) (*ThreadRef, error) {
	ref := &ThreadRef{}
	err := cdb.QueryRow(
		`SELECT id, name, message_count FROM thread_index WHERE source_message_id = ? LIMIT 1`,
		messageID,
	).Scan(&ref.ID, &ref.Name, &ref.MessageCount)
	if err != nil {
		return nil, err
	}
	return ref, nil
}

// GetThreadRefForMessage is the public API for fetching a thread ref by message ID.
// channelID must be the channel that contains the source message.
func (s *Store) GetThreadRefForMessage(messageID, channelID string) (*ThreadRef, error) {
	cdb, err := s.channels.For(channelID)
	if err != nil {
		return nil, err
	}
	return s.getThreadRefForMessageFromDB(cdb, messageID)
}
