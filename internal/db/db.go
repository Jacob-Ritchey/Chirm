package db

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"time"

	_ "modernc.org/sqlite"
)

// Permission bitmask constants
const (
	PermReadMessages   = 1 << 0
	PermSendMessages   = 1 << 1
	PermManageMessages = 1 << 2
	PermManageChannels = 1 << 3
	PermManageRoles    = 1 << 4
	PermManageServer   = 1 << 5
	PermAdministrator  = 1 << 6
)

type DB struct {
	*sql.DB
}

func Init(path string) (*DB, error) {
	sqldb, err := sql.Open("sqlite", path+"?_foreign_keys=on&_journal_mode=WAL")
	if err != nil {
		return nil, err
	}
	d := &DB{sqldb}
	if err := d.migrate(); err != nil {
		return nil, fmt.Errorf("migration failed: %w", err)
	}
	return d, nil
}

func (d *DB) migrate() error {
	schema := `
CREATE TABLE IF NOT EXISTS server_settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS users (
	id            TEXT PRIMARY KEY,
	username      TEXT UNIQUE NOT NULL,
	email         TEXT UNIQUE NOT NULL,
	password_hash TEXT NOT NULL,
	avatar        TEXT DEFAULT '',
	is_owner      INTEGER DEFAULT 0,
	created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS roles (
	id          TEXT PRIMARY KEY,
	name        TEXT NOT NULL,
	color       TEXT DEFAULT '#99AAB5',
	permissions INTEGER DEFAULT 3,
	position    INTEGER DEFAULT 0,
	created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_roles (
	user_id TEXT NOT NULL,
	role_id TEXT NOT NULL,
	PRIMARY KEY (user_id, role_id),
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
	FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channel_categories (
	id         TEXT PRIMARY KEY,
	name       TEXT NOT NULL,
	position   INTEGER DEFAULT 0,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channels (
	id          TEXT PRIMARY KEY,
	name        TEXT NOT NULL,
	description TEXT DEFAULT '',
	type        TEXT DEFAULT 'text',
	position    INTEGER DEFAULT 0,
	emoji       TEXT DEFAULT '',
	category_id TEXT DEFAULT '',
	created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
	id         TEXT PRIMARY KEY,
	channel_id TEXT NOT NULL,
	user_id    TEXT,
	content    TEXT NOT NULL,
	edited_at  DATETIME,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS attachments (
	id            TEXT PRIMARY KEY,
	message_id    TEXT,
	filename      TEXT NOT NULL,
	original_name TEXT NOT NULL,
	mime_type     TEXT NOT NULL,
	size          INTEGER NOT NULL,
	created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS invites (
	code       TEXT PRIMARY KEY,
	created_by TEXT NOT NULL,
	uses       INTEGER DEFAULT 0,
	max_uses   INTEGER DEFAULT 0,
	expires_at DATETIME,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reactions (
	message_id TEXT NOT NULL,
	user_id    TEXT NOT NULL,
	emoji      TEXT NOT NULL,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (message_id, user_id, emoji),
	FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
	FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS custom_emojis (
	id          TEXT PRIMARY KEY,
	name        TEXT UNIQUE NOT NULL,
	filename    TEXT NOT NULL,
	uploader_id TEXT NOT NULL,
	created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
	id         TEXT PRIMARY KEY,
	user_id    TEXT NOT NULL,
	endpoint   TEXT NOT NULL,
	data       TEXT NOT NULL,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
	UNIQUE(user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_custom_emojis_name ON custom_emojis(name);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
`
	_, err := d.Exec(schema)
	if err != nil {
		return err
	}
	// Idempotent column additions for existing DBs
	d.Exec(`ALTER TABLE messages ADD COLUMN reply_to_id TEXT`)
	d.Exec(`ALTER TABLE channels ADD COLUMN emoji TEXT DEFAULT ''`)
	d.Exec(`ALTER TABLE channels ADD COLUMN category_id TEXT DEFAULT ''`)
	return nil
}

// --- Helpers ---

func NewID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// --- Models ---

type User struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	Email        string    `json:"email,omitempty"`
	PasswordHash string    `json:"-"`
	Avatar       string    `json:"avatar"`
	IsOwner      bool      `json:"is_owner"`
	CreatedAt    time.Time `json:"created_at"`
	Roles        []Role    `json:"roles,omitempty"`
	Permissions  int       `json:"permissions,omitempty"`
}

type Role struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Color       string    `json:"color"`
	Permissions int       `json:"permissions"`
	Position    int       `json:"position"`
	CreatedAt   time.Time `json:"created_at"`
}

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

type ChannelCategory struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Position  int       `json:"position"`
	CreatedAt time.Time `json:"created_at"`
}

type Reaction struct {
	Emoji   string   `json:"emoji"`
	Count   int      `json:"count"`
	UserIDs []string `json:"user_ids"`
}

type MessageRef struct {
	ID         string `json:"id"`
	Content    string `json:"content"`
	AuthorName string `json:"author_name"`
}

type Message struct {
	ID          string       `json:"id"`
	ChannelID   string       `json:"channel_id"`
	UserID      string       `json:"user_id"`
	Content     string       `json:"content"`
	ReplyToID   *string      `json:"reply_to_id,omitempty"`
	ReplyTo     *MessageRef  `json:"reply_to,omitempty"`
	EditedAt    *time.Time   `json:"edited_at,omitempty"`
	CreatedAt   time.Time    `json:"created_at"`
	Author      *User        `json:"author,omitempty"`
	Attachments []Attachment `json:"attachments,omitempty"`
	Reactions   []Reaction   `json:"reactions,omitempty"`
}

type Attachment struct {
	ID           string    `json:"id"`
	MessageID    string    `json:"message_id"`
	Filename     string    `json:"filename"`
	OriginalName string    `json:"original_name"`
	MimeType     string    `json:"mime_type"`
	Size         int64     `json:"size"`
	CreatedAt    time.Time `json:"created_at"`
}

type Invite struct {
	Code      string     `json:"code"`
	CreatedBy string     `json:"created_by"`
	Uses      int        `json:"uses"`
	MaxUses   int        `json:"max_uses"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	Creator   *User      `json:"creator,omitempty"`
}

// --- Server Settings ---

func (d *DB) IsSetupDone() bool {
	var val string
	err := d.QueryRow(`SELECT value FROM server_settings WHERE key = 'setup_done'`).Scan(&val)
	return err == nil && val == "1"
}

func (d *DB) SetSetting(key, value string) error {
	_, err := d.Exec(`INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)`, key, value)
	return err
}

func (d *DB) GetSetting(key string) (string, error) {
	var val string
	err := d.QueryRow(`SELECT value FROM server_settings WHERE key = ?`, key).Scan(&val)
	return val, err
}

func (d *DB) GetAllSettings() (map[string]string, error) {
	rows, err := d.Query(`SELECT key, value FROM server_settings`)
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

// --- Users ---

func (d *DB) CreateUser(username, email, hash string, isOwner bool) (*User, error) {
	id := NewID()
	owner := 0
	if isOwner {
		owner = 1
	}
	_, err := d.Exec(
		`INSERT INTO users (id, username, email, password_hash, is_owner) VALUES (?, ?, ?, ?, ?)`,
		id, username, email, hash, owner,
	)
	if err != nil {
		return nil, err
	}
	return d.GetUserByID(id)
}

func (d *DB) GetUserByID(id string) (*User, error) {
	u := &User{}
	var owner int
	err := d.QueryRow(
		`SELECT id, username, email, password_hash, avatar, is_owner, created_at FROM users WHERE id = ?`, id,
	).Scan(&u.ID, &u.Username, &u.Email, &u.PasswordHash, &u.Avatar, &owner, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	u.IsOwner = owner == 1
	u.Roles, _ = d.GetUserRoles(id)
	u.Permissions = d.ComputePermissions(u)
	return u, nil
}

func (d *DB) GetUserByUsername(username string) (*User, error) {
	u := &User{}
	var owner int
	err := d.QueryRow(
		`SELECT id, username, email, password_hash, avatar, is_owner, created_at FROM users WHERE username = ?`, username,
	).Scan(&u.ID, &u.Username, &u.Email, &u.PasswordHash, &u.Avatar, &owner, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	u.IsOwner = owner == 1
	u.Roles, _ = d.GetUserRoles(u.ID)
	u.Permissions = d.ComputePermissions(u)
	return u, nil
}

func (d *DB) GetUserByEmail(email string) (*User, error) {
	u := &User{}
	var owner int
	err := d.QueryRow(
		`SELECT id, username, email, password_hash, avatar, is_owner, created_at FROM users WHERE email = ?`, email,
	).Scan(&u.ID, &u.Username, &u.Email, &u.PasswordHash, &u.Avatar, &owner, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	u.IsOwner = owner == 1
	u.Roles, _ = d.GetUserRoles(u.ID)
	u.Permissions = d.ComputePermissions(u)
	return u, nil
}

func (d *DB) ListUsers() ([]User, error) {
	rows, err := d.Query(`SELECT id, username, email, avatar, is_owner, created_at FROM users ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		var u User
		var owner int
		rows.Scan(&u.ID, &u.Username, &u.Email, &u.Avatar, &owner, &u.CreatedAt)
		u.IsOwner = owner == 1
		u.Roles, _ = d.GetUserRoles(u.ID)
		users = append(users, u)
	}
	return users, nil
}

func (d *DB) UpdateUser(id, username, avatar string) error {
	_, err := d.Exec(`UPDATE users SET username = ?, avatar = ? WHERE id = ?`, username, avatar, id)
	return err
}

func (d *DB) DeleteUser(id string) error {
	_, err := d.Exec(`DELETE FROM users WHERE id = ?`, id)
	return err
}

func (d *DB) UserCount() int {
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n
}

// --- Permissions ---

func (d *DB) ComputePermissions(u *User) int {
	if u.IsOwner {
		return PermAdministrator | PermManageServer | PermManageRoles | PermManageChannels | PermManageMessages | PermSendMessages | PermReadMessages
	}
	perms := 0
	// @everyone base permissions
	everyone, _ := d.GetEveryoneRole()
	if everyone != nil {
		perms |= everyone.Permissions
	}
	for _, r := range u.Roles {
		perms |= r.Permissions
	}
	return perms
}

func (d *DB) HasPermission(u *User, perm int) bool {
	p := u.Permissions
	if p&PermAdministrator != 0 {
		return true
	}
	return p&perm != 0
}

// --- Roles ---

func (d *DB) GetEveryoneRole() (*Role, error) {
	r := &Role{}
	err := d.QueryRow(`SELECT id, name, color, permissions, position, created_at FROM roles WHERE name = '@everyone' ORDER BY position ASC LIMIT 1`).
		Scan(&r.ID, &r.Name, &r.Color, &r.Permissions, &r.Position, &r.CreatedAt)
	if err != nil {
		return nil, err
	}
	return r, nil
}

func (d *DB) CreateRole(name, color string, permissions int) (*Role, error) {
	id := NewID()
	var pos int
	d.QueryRow(`SELECT COALESCE(MAX(position), 0) + 1 FROM roles`).Scan(&pos)
	_, err := d.Exec(`INSERT INTO roles (id, name, color, permissions, position) VALUES (?, ?, ?, ?, ?)`,
		id, name, color, permissions, pos)
	if err != nil {
		return nil, err
	}
	return d.GetRoleByID(id)
}

func (d *DB) GetRoleByID(id string) (*Role, error) {
	r := &Role{}
	err := d.QueryRow(`SELECT id, name, color, permissions, position, created_at FROM roles WHERE id = ?`, id).
		Scan(&r.ID, &r.Name, &r.Color, &r.Permissions, &r.Position, &r.CreatedAt)
	return r, err
}

func (d *DB) ListRoles() ([]Role, error) {
	rows, err := d.Query(`SELECT id, name, color, permissions, position, created_at FROM roles ORDER BY position ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roles []Role
	for rows.Next() {
		var r Role
		rows.Scan(&r.ID, &r.Name, &r.Color, &r.Permissions, &r.Position, &r.CreatedAt)
		roles = append(roles, r)
	}
	return roles, nil
}

func (d *DB) UpdateRole(id, name, color string, permissions int) error {
	_, err := d.Exec(`UPDATE roles SET name = ?, color = ?, permissions = ? WHERE id = ?`, name, color, permissions, id)
	return err
}

func (d *DB) DeleteRole(id string) error {
	_, err := d.Exec(`DELETE FROM roles WHERE id = ? AND name != '@everyone'`, id)
	return err
}

func (d *DB) GetUserRoles(userID string) ([]Role, error) {
	rows, err := d.Query(`
		SELECT r.id, r.name, r.color, r.permissions, r.position, r.created_at
		FROM roles r
		JOIN user_roles ur ON r.id = ur.role_id
		WHERE ur.user_id = ?
		ORDER BY r.position ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roles []Role
	for rows.Next() {
		var r Role
		rows.Scan(&r.ID, &r.Name, &r.Color, &r.Permissions, &r.Position, &r.CreatedAt)
		roles = append(roles, r)
	}
	return roles, nil
}

func (d *DB) AssignRole(userID, roleID string) error {
	_, err := d.Exec(`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`, userID, roleID)
	return err
}

func (d *DB) RemoveRole(userID, roleID string) error {
	_, err := d.Exec(`DELETE FROM user_roles WHERE user_id = ? AND role_id = ?`, userID, roleID)
	return err
}

// --- Channels ---

func (d *DB) CreateChannel(name, description, chType, emoji, categoryID string) (*Channel, error) {
	id := NewID()
	var pos int
	d.QueryRow(`SELECT COALESCE(MAX(position), 0) + 1 FROM channels WHERE category_id = ?`, categoryID).Scan(&pos)
	_, err := d.Exec(`INSERT INTO channels (id, name, description, type, position, emoji, category_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, name, description, chType, pos, emoji, categoryID)
	if err != nil {
		return nil, err
	}
	return d.GetChannelByID(id)
}

func (d *DB) GetChannelByID(id string) (*Channel, error) {
	c := &Channel{}
	err := d.QueryRow(`SELECT id, name, description, type, position, COALESCE(emoji,''), COALESCE(category_id,''), created_at FROM channels WHERE id = ?`, id).
		Scan(&c.ID, &c.Name, &c.Description, &c.Type, &c.Position, &c.Emoji, &c.CategoryID, &c.CreatedAt)
	return c, err
}

func (d *DB) ListChannels() ([]Channel, error) {
	rows, err := d.Query(`SELECT id, name, description, type, position, COALESCE(emoji,''), COALESCE(category_id,''), created_at FROM channels ORDER BY category_id ASC, position ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var channels []Channel
	for rows.Next() {
		var c Channel
		rows.Scan(&c.ID, &c.Name, &c.Description, &c.Type, &c.Position, &c.Emoji, &c.CategoryID, &c.CreatedAt)
		channels = append(channels, c)
	}
	return channels, nil
}

func (d *DB) UpdateChannel(id, name, description, emoji, categoryID string) error {
	_, err := d.Exec(`UPDATE channels SET name = ?, description = ?, emoji = ?, category_id = ? WHERE id = ?`, name, description, emoji, categoryID, id)
	return err
}

func (d *DB) ReorderChannels(orders []struct{ ID string; Position int; CategoryID string }) error {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	for _, o := range orders {
		tx.Exec(`UPDATE channels SET position = ?, category_id = ? WHERE id = ?`, o.Position, o.CategoryID, o.ID)
	}
	return tx.Commit()
}

// --- Channel Categories ---

func (d *DB) CreateCategory(name string) (*ChannelCategory, error) {
	id := NewID()
	var pos int
	d.QueryRow(`SELECT COALESCE(MAX(position), 0) + 1 FROM channel_categories`).Scan(&pos)
	_, err := d.Exec(`INSERT INTO channel_categories (id, name, position) VALUES (?, ?, ?)`, id, name, pos)
	if err != nil {
		return nil, err
	}
	cat := &ChannelCategory{}
	d.QueryRow(`SELECT id, name, position, created_at FROM channel_categories WHERE id = ?`, id).
		Scan(&cat.ID, &cat.Name, &cat.Position, &cat.CreatedAt)
	return cat, nil
}

func (d *DB) ListCategories() ([]ChannelCategory, error) {
	rows, err := d.Query(`SELECT id, name, position, created_at FROM channel_categories ORDER BY position ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cats []ChannelCategory
	for rows.Next() {
		var c ChannelCategory
		rows.Scan(&c.ID, &c.Name, &c.Position, &c.CreatedAt)
		cats = append(cats, c)
	}
	if cats == nil {
		cats = []ChannelCategory{}
	}
	return cats, nil
}

func (d *DB) UpdateCategory(id, name string) error {
	_, err := d.Exec(`UPDATE channel_categories SET name = ? WHERE id = ?`, name, id)
	return err
}

func (d *DB) DeleteCategory(id string) error {
	// Move channels in this category to uncategorized
	d.Exec(`UPDATE channels SET category_id = '' WHERE category_id = ?`, id)
	_, err := d.Exec(`DELETE FROM channel_categories WHERE id = ?`, id)
	return err
}

func (d *DB) ReorderCategories(orders []struct{ ID string; Position int }) error {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	for _, o := range orders {
		tx.Exec(`UPDATE channel_categories SET position = ? WHERE id = ?`, o.Position, o.ID)
	}
	return tx.Commit()
}

func (d *DB) DeleteChannel(id string) error {
	_, err := d.Exec(`DELETE FROM channels WHERE id = ?`, id)
	return err
}

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

func (d *DB) GetMessageByID(id string) (*Message, error) {
	m := &Message{}
	var editedAt sql.NullTime
	var replyToID sql.NullString
	err := d.QueryRow(`SELECT id, channel_id, user_id, content, reply_to_id, edited_at, created_at FROM messages WHERE id = ?`, id).
		Scan(&m.ID, &m.ChannelID, &m.UserID, &m.Content, &replyToID, &editedAt, &m.CreatedAt)
	if err != nil {
		return nil, err
	}
	if editedAt.Valid {
		m.EditedAt = &editedAt.Time
	}
	if replyToID.Valid {
		m.ReplyToID = &replyToID.String
		m.ReplyTo, _ = d.GetMessageRef(replyToID.String)
	}
	m.Author, _ = d.GetUserByID(m.UserID)
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
			SELECT id, channel_id, user_id, content, reply_to_id, edited_at, created_at 
			FROM messages WHERE channel_id = ?
			ORDER BY created_at DESC LIMIT ?`, channelID, limit)
	} else {
		rows, err = d.Query(`
			SELECT id, channel_id, user_id, content, reply_to_id, edited_at, created_at 
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
		rows.Scan(&m.ID, &m.ChannelID, &m.UserID, &m.Content, &replyToID, &editedAt, &m.CreatedAt)
		if editedAt.Valid {
			m.EditedAt = &editedAt.Time
		}
		if replyToID.Valid {
			m.ReplyToID = &replyToID.String
			m.ReplyTo, _ = d.GetMessageRef(replyToID.String)
		}
		m.Author, _ = d.GetUserByID(m.UserID)
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

// --- Invites ---

func (d *DB) CreateInvite(createdBy string, maxUses int, expiresAt *time.Time) (*Invite, error) {
	// Fix #10: Use full 16-char hex code (64-bit entropy) instead of 8-char (32-bit).
	code := NewID()
	if expiresAt != nil {
		_, err := d.Exec(`INSERT INTO invites (code, created_by, max_uses, expires_at) VALUES (?, ?, ?, ?)`,
			code, createdBy, maxUses, expiresAt)
		if err != nil {
			return nil, err
		}
	} else {
		_, err := d.Exec(`INSERT INTO invites (code, created_by, max_uses) VALUES (?, ?, ?)`,
			code, createdBy, maxUses)
		if err != nil {
			return nil, err
		}
	}
	return d.GetInviteByCode(code)
}

func (d *DB) GetInviteByCode(code string) (*Invite, error) {
	inv := &Invite{}
	var expires sql.NullTime
	err := d.QueryRow(`SELECT code, created_by, uses, max_uses, expires_at, created_at FROM invites WHERE code = ?`, code).
		Scan(&inv.Code, &inv.CreatedBy, &inv.Uses, &inv.MaxUses, &expires, &inv.CreatedAt)
	if err != nil {
		return nil, err
	}
	if expires.Valid {
		inv.ExpiresAt = &expires.Time
	}
	inv.Creator, _ = d.GetUserByID(inv.CreatedBy)
	return inv, nil
}

func (d *DB) ListInvites() ([]Invite, error) {
	rows, err := d.Query(`SELECT code, created_by, uses, max_uses, expires_at, created_at FROM invites ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var invites []Invite
	for rows.Next() {
		var inv Invite
		var expires sql.NullTime
		rows.Scan(&inv.Code, &inv.CreatedBy, &inv.Uses, &inv.MaxUses, &expires, &inv.CreatedAt)
		if expires.Valid {
			inv.ExpiresAt = &expires.Time
		}
		inv.Creator, _ = d.GetUserByID(inv.CreatedBy)
		invites = append(invites, inv)
	}
	return invites, nil
}

func (d *DB) UseInvite(code string) error {
	_, err := d.Exec(`UPDATE invites SET uses = uses + 1 WHERE code = ?`, code)
	return err
}

// IsInviteValid returns true if the invite has not exceeded its use limit
// and has not passed its expiry time. Fix #5: expiry was stored but never checked.
func (d *DB) IsInviteValid(inv *Invite) bool {
	if inv.MaxUses > 0 && inv.Uses >= inv.MaxUses {
		return false
	}
	if inv.ExpiresAt != nil && time.Now().After(*inv.ExpiresAt) {
		return false
	}
	return true
}

func (d *DB) DeleteInvite(code string) error {
	_, err := d.Exec(`DELETE FROM invites WHERE code = ?`, code)
	return err
}

// CleanOrphanedAttachments deletes attachment records (and their files on disk)
// that were never linked to a message and are older than maxAge.
// Fix #9: prevents unbounded disk growth from abandoned uploads.
func (d *DB) CleanOrphanedAttachments(uploadsDir string, maxAge time.Duration) error {
	cutoff := time.Now().Add(-maxAge)
	rows, err := d.Query(
		`SELECT id, filename FROM attachments WHERE message_id IS NULL AND created_at < ?`, cutoff)
	if err != nil {
		return err
	}

	type orphan struct{ id, filename string }
	var orphans []orphan
	for rows.Next() {
		var o orphan
		if rows.Scan(&o.id, &o.filename) == nil {
			orphans = append(orphans, o)
		}
	}
	rows.Close()

	for _, o := range orphans {
		d.Exec(`DELETE FROM attachments WHERE id = ?`, o.id)
		os.Remove(uploadsDir + "/" + o.filename)
	}
	return nil
}

// --- Custom Emojis ---

type CustomEmoji struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Filename   string    `json:"filename"`
	UploaderID string    `json:"uploader_id"`
	Uploader   *User     `json:"uploader,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

func (d *DB) CreateCustomEmoji(name, filename, uploaderID string) (*CustomEmoji, error) {
	id := NewID()
	_, err := d.Exec(`INSERT INTO custom_emojis (id, name, filename, uploader_id) VALUES (?, ?, ?, ?)`,
		id, name, filename, uploaderID)
	if err != nil {
		return nil, err
	}
	return d.GetCustomEmojiByID(id)
}

func (d *DB) GetCustomEmojiByID(id string) (*CustomEmoji, error) {
	e := &CustomEmoji{}
	err := d.QueryRow(`SELECT id, name, filename, uploader_id, created_at FROM custom_emojis WHERE id = ?`, id).
		Scan(&e.ID, &e.Name, &e.Filename, &e.UploaderID, &e.CreatedAt)
	if err != nil {
		return nil, err
	}
	e.Uploader, _ = d.GetUserByID(e.UploaderID)
	return e, nil
}

func (d *DB) ListCustomEmojis() ([]CustomEmoji, error) {
	rows, err := d.Query(`SELECT id, name, filename, uploader_id, created_at FROM custom_emojis ORDER BY name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var emojis []CustomEmoji
	for rows.Next() {
		var e CustomEmoji
		rows.Scan(&e.ID, &e.Name, &e.Filename, &e.UploaderID, &e.CreatedAt)
		e.Uploader, _ = d.GetUserByID(e.UploaderID)
		emojis = append(emojis, e)
	}
	if emojis == nil {
		emojis = []CustomEmoji{}
	}
	return emojis, nil
}

func (d *DB) DeleteCustomEmoji(id string) (string, error) {
	var filename string
	err := d.QueryRow(`SELECT filename FROM custom_emojis WHERE id = ?`, id).Scan(&filename)
	if err != nil {
		return "", err
	}
	_, err = d.Exec(`DELETE FROM custom_emojis WHERE id = ?`, id)
	return filename, err
}

func (d *DB) GetCustomEmojiByName(name string) (*CustomEmoji, error) {
	e := &CustomEmoji{}
	err := d.QueryRow(`SELECT id, name, filename, uploader_id, created_at FROM custom_emojis WHERE name = ?`, name).
		Scan(&e.ID, &e.Name, &e.Filename, &e.UploaderID, &e.CreatedAt)
	if err != nil {
		return nil, err
	}
	return e, nil
}

// ─── Push Subscriptions ───────────────────────────────────────────────────────

type PushSubscription struct {
	ID       string
	UserID   string
	Endpoint string
	Data     string
}

func (d *DB) SavePushSubscription(userID, data string) error {
	// Parse endpoint from data JSON to use as dedup key
	var sub struct {
		Endpoint string `json:"endpoint"`
	}
	if err := json.Unmarshal([]byte(data), &sub); err != nil || sub.Endpoint == "" {
		return fmt.Errorf("invalid subscription data")
	}
	// Remove any existing subscription for this endpoint regardless of user.
	// This prevents stale entries from account-switching on the same device:
	// if user A subscribed then logged out without unsubscribing, user B logging
	// in on the same browser would otherwise leave A's entry pointing at B's device.
	_, _ = d.Exec(`DELETE FROM push_subscriptions WHERE endpoint=?`, sub.Endpoint)
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

// GetChannelPushSubscriptions returns all push subscriptions for users who are
// NOT the specified channel (all users get pushes — channel-level mute is
// enforced client-side). The channelName param is unused here but kept for future filtering.
func (d *DB) GetChannelPushSubscriptions(_ string) ([]PushSubscription, error) {
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
