package db

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"chirm/internal/crypto"
	_ "modernc.org/sqlite"
)

// Permission bitmask constants.
const (
	PermReadMessages   = 1 << 0
	PermSendMessages   = 1 << 1
	PermManageMessages = 1 << 2
	PermManageChannels = 1 << 3
	PermManageRoles    = 1 << 4
	PermManageServer   = 1 << 5
	PermAdministrator  = 1 << 6
)

// Store is the top-level database handle. It owns three fixed SQLite files
// (auth, members, server) plus a per-channel DB pool managed by ChannelStore.
type Store struct {
	auth     *sql.DB
	members  *sql.DB
	server   *sql.DB
	channels *ChannelStore
	encKey   *[32]byte // nil when CHIRM_ENCRYPTION_KEY is not set
}

// New opens (or creates) the four database tiers under dataDir and runs
// any pending migrations on each. encKey may be nil (encryption disabled).
func New(dataDir string, encKey *[32]byte) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dataDir, "channels"), 0755); err != nil {
		return nil, fmt.Errorf("create channels dir: %w", err)
	}

	s := &Store{encKey: encKey}
	var err error

	s.auth, err = openDB(filepath.Join(dataDir, "auth.db"))
	if err != nil {
		return nil, fmt.Errorf("open auth.db: %w", err)
	}
	if err = runMigrations(s.auth, "auth"); err != nil {
		return nil, fmt.Errorf("auth migrations: %w", err)
	}

	s.members, err = openDB(filepath.Join(dataDir, "members.db"))
	if err != nil {
		return nil, fmt.Errorf("open members.db: %w", err)
	}
	if err = runMigrations(s.members, "members"); err != nil {
		return nil, fmt.Errorf("members migrations: %w", err)
	}

	s.server, err = openDB(filepath.Join(dataDir, "server.db"))
	if err != nil {
		return nil, fmt.Errorf("open server.db: %w", err)
	}
	if err = runMigrations(s.server, "server"); err != nil {
		return nil, fmt.Errorf("server migrations: %w", err)
	}

	s.channels, err = newChannelStore(filepath.Join(dataDir, "channels"))
	if err != nil {
		return nil, fmt.Errorf("channel store: %w", err)
	}

	return s, nil
}

// Close shuts down all database handles.
func (s *Store) Close() {
	if s.auth != nil {
		s.auth.Close()
	}
	if s.members != nil {
		s.members.Close()
	}
	if s.server != nil {
		s.server.Close()
	}
	if s.channels != nil {
		s.channels.closeAll()
	}
}

// openDB opens a SQLite database file with WAL mode and busy timeout.
func openDB(path string) (*sql.DB, error) {
	return sql.Open("sqlite", path+"?_foreign_keys=on&_journal_mode=WAL&_busy_timeout=5000")
}

// NewID generates a random 16-character hex string for use as a record ID.
func NewID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// encryptField encrypts a DB field value when encryption is enabled.
// Returns the plaintext unchanged when encKey is nil or plaintext is empty.
func (s *Store) encryptField(recordID, field, plaintext string) (string, error) {
	if s.encKey == nil || plaintext == "" {
		return plaintext, nil
	}
	return crypto.EncryptField(s.encKey, recordID, field, plaintext)
}

// decryptField decrypts a DB field value when encryption is enabled.
// Returns the value unchanged when encKey is nil, value is empty, or value
// lacks the enc: prefix (legacy plaintext — fail-open for lazy migration).
func (s *Store) decryptField(recordID, field, value string) string {
	if s.encKey == nil || value == "" {
		return value
	}
	dec, err := crypto.DecryptField(s.encKey, recordID, field, value)
	if err != nil {
		// ErrNotEncrypted = legacy plaintext row; other errors = corrupt data.
		// Fail-open in both cases so old unencrypted records remain readable.
		return value
	}
	return dec
}
