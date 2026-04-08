package db

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"

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
	sqldb, err := sql.Open("sqlite", path+"?_foreign_keys=on&_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return nil, err
	}
	d := &DB{sqldb}
	if err := d.runMigrations(); err != nil {
		return nil, fmt.Errorf("migration failed: %w", err)
	}
	return d, nil
}

// NewID generates a random 16-character hex string for use as a record ID.
func NewID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}
