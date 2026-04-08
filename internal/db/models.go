package db

import "time"

// Bot represents an API bot that can send messages programmatically.
type Bot struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Token       string    `json:"token,omitempty"` // only emitted on create/regen
	Permissions int       `json:"permissions"`
	CreatedAt   time.Time `json:"created_at"`
}

// User represents a registered user account.
type User struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	Email        string    `json:"email,omitempty"`
	PasswordHash string    `json:"-"`
	Avatar       string    `json:"avatar"`
	Bio          string    `json:"bio"`
	Links        string    `json:"links"`   // JSON: [{"label":"...","url":"..."}]
	Banner       string    `json:"banner"`
	Status       string    `json:"status"`  // online | away | dnd
	IsOwner      bool      `json:"is_owner"`
	CreatedAt    time.Time `json:"created_at"`
	Roles        []Role    `json:"roles,omitempty"`
	Permissions  int       `json:"permissions,omitempty"`
}

// Role represents a permission role that can be assigned to users.
type Role struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Color       string    `json:"color"`
	Permissions int       `json:"permissions"`
	Position    int       `json:"position"`
	CreatedAt   time.Time `json:"created_at"`
}

// Channel represents a text or voice channel.
type Channel struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Type        string    `json:"type"`
	Position    int       `json:"position"`
	Emoji       string    `json:"emoji"`
	CategoryID  string    `json:"category_id"`
	CreatedAt   time.Time `json:"created_at"`
}

// ChannelCategory groups channels together in the sidebar.
type ChannelCategory struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Position  int       `json:"position"`
	CreatedAt time.Time `json:"created_at"`
}

// Reaction represents an aggregated emoji reaction on a message.
type Reaction struct {
	Emoji   string   `json:"emoji"`
	Count   int      `json:"count"`
	UserIDs []string `json:"user_ids"`
}

// MessageRef is a compact reference to a message used for reply previews.
type MessageRef struct {
	ID         string `json:"id"`
	Content    string `json:"content"`
	AuthorName string `json:"author_name"`
}

// Thread represents a named sub-conversation within a channel.
type Thread struct {
	ID              string    `json:"id"`
	ChannelID       string    `json:"channel_id"`
	ThreadChannelID string    `json:"thread_channel_id,omitempty"`
	Name            string    `json:"name"`
	CreatorID       string    `json:"creator_id,omitempty"`
	Creator         *User     `json:"creator,omitempty"`
	SourceMessageID *string   `json:"source_message_id,omitempty"`
	MessageCount    int       `json:"message_count"`
	LastActivityAt  time.Time `json:"last_activity_at"`
	CreatedAt       time.Time `json:"created_at"`
}

// ThreadRef is a compact thread reference embedded in channel messages
// to show a "thread started" indicator on the source message.
type ThreadRef struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	MessageCount int    `json:"message_count"`
}

// Message represents a chat message.
type Message struct {
	ID          string       `json:"id"`
	ChannelID   string       `json:"channel_id"`
	UserID      string       `json:"user_id,omitempty"` // empty for bot messages
	BotID       *string      `json:"bot_id,omitempty"`
	Content     string       `json:"content"`
	ReplyToID   *string      `json:"reply_to_id,omitempty"`
	ReplyTo     *MessageRef  `json:"reply_to,omitempty"`
	ThreadID    *string      `json:"thread_id,omitempty"`
	Thread      *ThreadRef   `json:"thread,omitempty"` // set when this msg is the source_message of a thread
	EditedAt    *time.Time   `json:"edited_at,omitempty"`
	CreatedAt   time.Time    `json:"created_at"`
	Author      *User        `json:"author,omitempty"` // nil for bot messages
	Bot         *Bot         `json:"bot,omitempty"`    // set for bot messages
	Attachments []Attachment `json:"attachments,omitempty"`
	Reactions   []Reaction   `json:"reactions,omitempty"`
}

// Attachment represents a file attached to a message.
type Attachment struct {
	ID           string    `json:"id"`
	MessageID    string    `json:"message_id"`
	Filename     string    `json:"filename"`
	OriginalName string    `json:"original_name"`
	MimeType     string    `json:"mime_type"`
	Size         int64     `json:"size"`
	CreatedAt    time.Time `json:"created_at"`
}

// Invite represents a server invite link.
type Invite struct {
	Code      string     `json:"code"`
	CreatedBy string     `json:"created_by"`
	Uses      int        `json:"uses"`
	MaxUses   int        `json:"max_uses"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	Creator   *User      `json:"creator,omitempty"`
}

// CustomEmoji represents a server-specific custom emoji.
type CustomEmoji struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Filename   string    `json:"filename"`
	UploaderID string    `json:"uploader_id"`
	Uploader   *User     `json:"uploader,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

// PushSubscription stores a Web Push endpoint for a user.
type PushSubscription struct {
	ID       string
	UserID   string
	Endpoint string
	Data     string
}
