package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// ChannelStore manages a pool of per-channel SQLite databases. Each channel
// (including thread channels) gets its own file under the channels/ directory.
// Handles are opened lazily on first use and cached for subsequent requests.
type ChannelStore struct {
	dir string
	mu  sync.RWMutex
	dbs map[string]*sql.DB
}

// newChannelStore opens all existing *.db files under dir and returns a ready
// ChannelStore. Called once at startup.
func newChannelStore(dir string) (*ChannelStore, error) {
	cs := &ChannelStore{
		dir: dir,
		dbs: make(map[string]*sql.DB),
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read channel dir: %w", err)
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".db" {
			continue
		}
		id := e.Name()[:len(e.Name())-3]
		db, err := cs.openAndMigrate(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, fmt.Errorf("open channel DB %s: %w", id, err)
		}
		cs.dbs[id] = db
	}
	return cs, nil
}

// For returns the database handle for the given channel, opening and migrating
// it on first access.
func (cs *ChannelStore) For(channelID string) (*sql.DB, error) {
	cs.mu.RLock()
	db, ok := cs.dbs[channelID]
	cs.mu.RUnlock()
	if ok {
		return db, nil
	}
	return cs.Create(channelID)
}

// Create opens a new channel database (or returns existing), runs migrations,
// and caches the handle.
func (cs *ChannelStore) Create(channelID string) (*sql.DB, error) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	// Double-check under write lock.
	if db, ok := cs.dbs[channelID]; ok {
		return db, nil
	}
	path := filepath.Join(cs.dir, channelID+".db")
	db, err := cs.openAndMigrate(path)
	if err != nil {
		return nil, err
	}
	cs.dbs[channelID] = db
	return db, nil
}

// Delete closes and removes the database file for the given channel.
func (cs *ChannelStore) Delete(channelID string) error {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	if db, ok := cs.dbs[channelID]; ok {
		db.Close()
		delete(cs.dbs, channelID)
	}
	path := filepath.Join(cs.dir, channelID+".db")
	os.Remove(path)
	os.Remove(path + "-wal")
	os.Remove(path + "-shm")
	return nil
}

// All returns all currently open channel database handles. Used for
// reconciliation sweeps (storage, propagation).
func (cs *ChannelStore) All() []*sql.DB {
	cs.mu.RLock()
	defer cs.mu.RUnlock()
	dbs := make([]*sql.DB, 0, len(cs.dbs))
	for _, db := range cs.dbs {
		dbs = append(dbs, db)
	}
	return dbs
}

// AllIDs returns all currently open channel IDs.
func (cs *ChannelStore) AllIDs() []string {
	cs.mu.RLock()
	defer cs.mu.RUnlock()
	ids := make([]string, 0, len(cs.dbs))
	for id := range cs.dbs {
		ids = append(ids, id)
	}
	return ids
}

func (cs *ChannelStore) closeAll() {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	for _, db := range cs.dbs {
		db.Close()
	}
}

func (cs *ChannelStore) openAndMigrate(path string) (*sql.DB, error) {
	db, err := openDB(path)
	if err != nil {
		return nil, err
	}
	if err := runMigrations(db, "channel"); err != nil {
		db.Close()
		return nil, fmt.Errorf("channel migration: %w", err)
	}
	return db, nil
}
