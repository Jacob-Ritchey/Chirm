package db

import (
	"database/sql"
	"embed"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

//go:embed migrations
var migrationFS embed.FS

// runMigrations creates the schema_version tracking table in the given database
// and applies any pending numbered SQL files from migrations/{subdir}/.
func runMigrations(db *sql.DB, subdir string) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS schema_version (
		version    INTEGER PRIMARY KEY,
		applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)`)
	if err != nil {
		return fmt.Errorf("create schema_version: %w", err)
	}

	var current int
	db.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_version`).Scan(&current)

	dir := "migrations/" + subdir
	entries, err := migrationFS.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("read migrations dir %s: %w", dir, err)
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Name() < entries[j].Name()
	})

	for _, entry := range entries {
		version := parseMigrationVersion(entry.Name())
		if version <= current {
			continue
		}
		sql, err := migrationFS.ReadFile(dir + "/" + entry.Name())
		if err != nil {
			return fmt.Errorf("read migration %s: %w", entry.Name(), err)
		}
		if _, err := db.Exec(string(sql)); err != nil {
			return fmt.Errorf("migration %s/%s failed: %w", subdir, entry.Name(), err)
		}
		if _, err := db.Exec(`INSERT INTO schema_version (version) VALUES (?)`, version); err != nil {
			return fmt.Errorf("record migration %d: %w", version, err)
		}
	}
	return nil
}

// parseMigrationVersion extracts the leading integer from a filename like "001_initial.sql" → 1.
func parseMigrationVersion(name string) int {
	parts := strings.SplitN(name, "_", 2)
	if len(parts) == 0 {
		return 0
	}
	n, _ := strconv.Atoi(parts[0])
	return n
}
