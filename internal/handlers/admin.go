package handlers

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"

	"chirm/internal/db"
)

// AdminWipe permanently destroys all server data: databases, uploaded files,
// and WAL/SHM sidecar files. This action is irreversible.
//
// The request body must contain { "confirm": "WIPE ALL DATA" } to prevent
// accidental triggers.
//
// Security note: file overwriting at the application layer does not guarantee
// physical data destruction on SSDs due to wear levelling. Full-disk encryption
// (LUKS on Linux) is the recommended complement for hardware disposal.
func (h *Handler) AdminWipe(w http.ResponseWriter, r *http.Request) {
	if _, isOwner := h.requireOwner(w, r); !isOwner {
		return
	}

	var req struct {
		Confirm string `json:"confirm"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Confirm != "WIPE ALL DATA" {
		errResp(w, http.StatusBadRequest, `confirmation required: send {"confirm":"WIPE ALL DATA"}`)
		return
	}

	uploadsDir := filepath.Join(h.dataDir, "uploads")
	channelsDir := filepath.Join(h.dataDir, "channels")

	// Wipe uploaded files.
	if err := wipeDir(uploadsDir); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to wipe uploads")
		return
	}

	// Wipe per-channel database files.
	if err := wipeDir(channelsDir); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to wipe channel databases")
		return
	}

	// Wipe the three fixed database files plus their WAL/SHM sidecars.
	for _, base := range []string{"auth.db", "members.db", "server.db"} {
		for _, suffix := range []string{"", "-wal", "-shm"} {
			path := filepath.Join(h.dataDir, base+suffix)
			wipeAndRemove(path) // best-effort; ignore errors for sidecar files
		}
	}

	ok(w, map[string]string{
		"message": "All data wiped. " +
			"Note: SSDs do not guarantee physical sector overwrite due to wear levelling. " +
			"Use full-disk encryption (e.g. LUKS) as the primary control for hardware disposal.",
	})
}

// requireOwner checks that the current user is the server owner.
// It writes the appropriate error response and returns (nil, false) on failure.
func (h *Handler) requireOwner(w http.ResponseWriter, r *http.Request) (*db.User, bool) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return nil, false
	}
	if !u.IsOwner {
		errResp(w, http.StatusForbidden, "owner only")
		return nil, false
	}
	return u, true
}

// wipeDir overwrites and removes every file inside dir (non-recursive for
// safety — channel DBs and uploads are all flat directories).
func wipeDir(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // nothing to wipe
		}
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue // skip subdirectories (uploads/ and channels/ are flat)
		}
		wipeAndRemove(filepath.Join(dir, e.Name()))
	}
	return nil
}

// wipeAndRemove overwrites a file with zeros then removes it.
// Errors are silently ignored — this is best-effort; the caller
// handles the overall error state.
func wipeAndRemove(path string) {
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		os.Remove(path)
		return
	}
	info, err := f.Stat()
	if err == nil && info.Size() > 0 {
		const chunkSize = 64 * 1024
		zeros := make([]byte, chunkSize)
		remaining := info.Size()
		for remaining > 0 {
			n := int64(chunkSize)
			if remaining < n {
				n = remaining
			}
			f.Write(zeros[:n])
			remaining -= n
		}
		f.Sync()
	}
	f.Close()
	os.Remove(path)
}
