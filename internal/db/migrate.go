package db

import (
	"embed"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// runMigrations creates the schema_version tracking table and applies any
// pending numbered SQL migration files in order.
func (d *DB) runMigrations() error {
	// Create the version-tracking table if it doesn't exist.
	_, err := d.Exec(`CREATE TABLE IF NOT EXISTS schema_version (
		version    INTEGER PRIMARY KEY,
		applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)`)
	if err != nil {
		return fmt.Errorf("create schema_version: %w", err)
	}

	// Determine the highest version already applied.
	var current int
	d.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_version`).Scan(&current)

	// Read and sort migration file names.
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("read migrations dir: %w", err)
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Name() < entries[j].Name()
	})

	for _, entry := range entries {
		version := parseMigrationVersion(entry.Name())
		if version <= current {
			continue
		}
		sql, err := migrationFS.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return fmt.Errorf("read migration %s: %w", entry.Name(), err)
		}
		if _, err := d.Exec(string(sql)); err != nil {
			return fmt.Errorf("migration %s failed: %w", entry.Name(), err)
		}
		if _, err := d.Exec(`INSERT INTO schema_version (version) VALUES (?)`, version); err != nil {
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
