package db

import (
	"database/sql"
	"time"
)

// --- Messages ---

func (d *DB) CreateMessage(channelID, userID, content string, replyToID *string) (*Message, error) {
	id := NewID()
	_, err := d.Exec(`INSERT INTO messages (id, channel_id, user_id, content, reply_to_id) VALUES (?, ?, ?, ?, ?)`,
		id, channelID, userID, content, replyToID)
	if err != nil {
		return nil, err
	}
	return d.GetMessageByID(id)
}

func (d *DB) CreateMessageFromBot(channelID, botID, content string, replyToID *string) (*Message, error) {
	id := NewID()
	_, err := d.Exec(`INSERT INTO messages (id, channel_id, bot_id, content, reply_to_id) VALUES (?, ?, ?, ?, ?)`,
		id, channelID, botID, content, replyToID)
	if err != nil {
		return nil, err
	}
	return d.GetMessageByID(id)
}

func (d *DB) GetMessageByID(id string) (*Message, error) {
	m := &Message{}
	var editedAt sql.NullTime
	var replyToID sql.NullString
	var userID sql.NullString
	var botID sql.NullString
	err := d.QueryRow(`SELECT id, channel_id, user_id, bot_id, content, reply_to_id, edited_at, created_at FROM messages WHERE id = ?`, id).
		Scan(&m.ID, &m.ChannelID, &userID, &botID, &m.Content, &replyToID, &editedAt, &m.CreatedAt)
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
		m.ReplyTo, _ = d.GetMessageRef(replyToID.String)
	}
	if m.UserID != "" {
		m.Author, _ = d.GetUserByID(m.UserID)
	}
	if m.BotID != nil {
		m.Bot, _ = d.GetBotByID(*m.BotID)
	}
	m.Attachments, _ = d.GetAttachments(m.ID)
	m.Reactions, _ = d.GetReactions(m.ID)
	return m, nil
}

func (d *DB) GetMessageRef(id string) (*MessageRef, error) {
	ref := &MessageRef{ID: id}
	var authorID string
	err := d.QueryRow(`SELECT content, user_id FROM messages WHERE id = ?`, id).
		Scan(&ref.Content, &authorID)
	if err != nil {
		return nil, err
	}
	u, _ := d.GetUserByID(authorID)
	if u != nil {
		ref.AuthorName = u.Username
	} else {
		ref.AuthorName = "Deleted User"
	}
	// Truncate for preview
	if len(ref.Content) > 100 {
		ref.Content = ref.Content[:97] + "..."
	}
	return ref, nil
}

func (d *DB) GetMessages(channelID string, before string, limit int) ([]Message, error) {
	var rows *sql.Rows
	var err error
	if before == "" {
		rows, err = d.Query(`
			SELECT id, channel_id, user_id, bot_id, content, reply_to_id, edited_at, created_at
			FROM messages WHERE channel_id = ?
			ORDER BY created_at DESC LIMIT ?`, channelID, limit)
	} else {
		rows, err = d.Query(`
			SELECT id, channel_id, user_id, bot_id, content, reply_to_id, edited_at, created_at
			FROM messages WHERE channel_id = ? AND created_at < (SELECT created_at FROM messages WHERE id = ?)
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
		var replyToID sql.NullString
		var userID sql.NullString
		var botID sql.NullString
		rows.Scan(&m.ID, &m.ChannelID, &userID, &botID, &m.Content, &replyToID, &editedAt, &m.CreatedAt)
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
			m.ReplyTo, _ = d.GetMessageRef(replyToID.String)
		}
		if m.UserID != "" {
			m.Author, _ = d.GetUserByID(m.UserID)
		}
		if m.BotID != nil {
			m.Bot, _ = d.GetBotByID(*m.BotID)
		}
		m.Attachments, _ = d.GetAttachments(m.ID)
		m.Reactions, _ = d.GetReactions(m.ID)
		msgs = append(msgs, m)
	}
	// Reverse so oldest first
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	return msgs, nil
}

func (d *DB) EditMessage(id, content string) error {
	now := time.Now()
	_, err := d.Exec(`UPDATE messages SET content = ?, edited_at = ? WHERE id = ?`, content, now, id)
	return err
}

func (d *DB) DeleteMessage(id string) error {
	_, err := d.Exec(`DELETE FROM messages WHERE id = ?`, id)
	return err
}

// --- Attachments ---

func (d *DB) CreateAttachment(messageID, filename, originalName, mimeType string, size int64) (*Attachment, error) {
	id := NewID()
	var msgID interface{}
	if messageID != "" {
		msgID = messageID
	}
	_, err := d.Exec(`INSERT INTO attachments (id, message_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?, ?)`,
		id, msgID, filename, originalName, mimeType, size)
	if err != nil {
		return nil, err
	}
	a := &Attachment{ID: id, MessageID: messageID, Filename: filename, OriginalName: originalName, MimeType: mimeType, Size: size}
	return a, nil
}

func (d *DB) GetAttachments(messageID string) ([]Attachment, error) {
	rows, err := d.Query(`SELECT id, message_id, filename, original_name, mime_type, size, created_at FROM attachments WHERE message_id = ?`, messageID)
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

func (d *DB) LinkAttachment(attachmentID, messageID string) error {
	_, err := d.Exec(`UPDATE attachments SET message_id = ? WHERE id = ?`, messageID, attachmentID)
	return err
}

// --- Reactions ---

func (d *DB) AddReaction(messageID, userID, emoji string) error {
	_, err := d.Exec(`INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)`,
		messageID, userID, emoji)
	return err
}

func (d *DB) RemoveReaction(messageID, userID, emoji string) error {
	_, err := d.Exec(`DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
		messageID, userID, emoji)
	return err
}

func (d *DB) GetReactions(messageID string) ([]Reaction, error) {
	rows, err := d.Query(`SELECT emoji, user_id FROM reactions WHERE message_id = ? ORDER BY emoji, created_at`, messageID)
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
