package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"chirm/internal/crypto"
)

var allowedMimeTypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
	// SVG intentionally excluded — browsers execute embedded scripts in SVG,
	// making it a stored XSS vector when served from the same origin.
	"video/mp4":        true,
	"video/webm":       true,
	"audio/mpeg":       true,
	"audio/ogg":        true,
	"audio/wav":        true,
	"application/pdf":  true,
	"text/plain":       true,
	"application/zip":  true,
}

func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	// Get max upload size from settings
	maxMBStr, _ := h.store.GetSetting("max_upload_mb")
	maxMB := int64(25)
	if n, err := strconv.ParseInt(maxMBStr, 10, 64); err == nil && n > 0 {
		maxMB = n
	}
	maxBytes := maxMB * 1024 * 1024

	// Enforce per-user storage quota if configured.
	quotaMBStr, _ := h.store.GetSetting("storage_quota_mb")
	if quotaMB, qErr := strconv.ParseInt(quotaMBStr, 10, 64); qErr == nil && quotaMB > 0 {
		quotaBytes := quotaMB * 1024 * 1024
		used := h.store.GetStorageUsed(u.ID)
		if used >= quotaBytes {
			errResp(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("storage quota exceeded (%dMB limit)", quotaMB))
			return
		}
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	if err := r.ParseMultipartForm(maxBytes); err != nil {
		errResp(w, http.StatusBadRequest, fmt.Sprintf("file too large (max %dMB)", maxMB))
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		errResp(w, http.StatusBadRequest, "no file provided")
		return
	}
	defer file.Close()

	// Detect MIME type from first 512 bytes
	buf := make([]byte, 512)
	n, _ := file.Read(buf)
	mimeType := http.DetectContentType(buf[:n])

	if !allowedMimeTypes[mimeType] {
		// Try from extension as fallback
		ext := strings.ToLower(filepath.Ext(header.Filename))
		extMimes := map[string]string{
			".pdf":  "application/pdf",
			".txt":  "text/plain",
			".zip":  "application/zip",
			".mp3":  "audio/mpeg",
			".ogg":  "audio/ogg",
			".wav":  "audio/wav",
			".mp4":  "video/mp4",
			".webm": "video/webm",
		}
		if m, ok := extMimes[ext]; ok {
			mimeType = m
		} else {
			errResp(w, http.StatusBadRequest, "file type not allowed")
			return
		}
	}

	// Seek back to start
	file.Seek(0, io.SeekStart)

	// Generate safe filename
	ext := filepath.Ext(header.Filename)
	filename := fmt.Sprintf("%s%s", newID(), ext)
	destPath := filepath.Join(h.dataDir, "uploads", filename)

	size, err := h.writeEncryptedFile(destPath, file)
	if err != nil {
		os.Remove(destPath)
		errResp(w, http.StatusInternalServerError, "failed to write file")
		return
	}

	// Create attachment record (message_id will be "" until attached to a message)
	att, err := h.store.CreateAttachment(u.ID, filename, header.Filename, mimeType, size)
	if err != nil {
		os.Remove(destPath)
		errResp(w, http.StatusInternalServerError, "failed to record upload")
		return
	}

	// Track storage usage for quota enforcement.
	h.store.AddStorageUsed(u.ID, size)

	created(w, map[string]interface{}{
		"id":            att.ID,
		"filename":      filename,
		"original_name": header.Filename,
		"mime_type":     mimeType,
		"size":          size,
		"url":           "/api/v1/uploads/" + filename,
	})
}

func (h *Handler) ServeUpload(w http.ResponseWriter, r *http.Request) {
	filename := chi.URLParam(r, "filename")
	// Sanitize: strip any path traversal attempts.
	filename = filepath.Base(filename)
	if strings.Contains(filename, "..") {
		http.Error(w, "invalid filename", http.StatusBadRequest)
		return
	}
	path := filepath.Join(h.dataDir, "uploads", filename)

	// Strict CSP: prevent any inline execution from served content.
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	// Inline display for images/video/audio; force download for everything else.
	ext := strings.ToLower(filepath.Ext(filename))
	inlineExts := map[string]bool{
		".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true,
		".mp4": true, ".webm": true, ".mp3": true, ".ogg": true, ".wav": true,
	}
	if inlineExts[ext] {
		w.Header().Set("Content-Disposition", "inline")
	} else {
		w.Header().Set("Content-Disposition", "attachment; filename=\""+filename+"\"")
	}

	h.readDecryptedFile(w, r, path)
}

// ServePublicUpload serves server-wide public assets (server icon, login background)
// without authentication. Only filenames with the server_icon_ or login_bg_ prefix
// are served; all others return 404, keeping user content behind auth.
func (h *Handler) ServePublicUpload(w http.ResponseWriter, r *http.Request) {
	filename := filepath.Base(chi.URLParam(r, "filename"))
	if strings.Contains(filename, "..") {
		http.Error(w, "invalid filename", http.StatusBadRequest)
		return
	}
	if !strings.HasPrefix(filename, "server_icon_") && !strings.HasPrefix(filename, "login_bg_") {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(h.dataDir, "uploads", filename)
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", "inline")
	http.ServeFile(w, r, path)
}

// newID generates a random hex ID for filenames
func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// writeEncryptedFile reads src into memory, optionally encrypts it, and writes
// the result to path. Returns the plaintext byte count (for quota tracking).
// If h.encKey is nil the file is written as-is (encryption disabled).
func (h *Handler) writeEncryptedFile(path string, src io.Reader) (int64, error) {
	data, err := io.ReadAll(src)
	if err != nil {
		return 0, err
	}
	plainSize := int64(len(data))
	if h.encKey != nil {
		data, err = crypto.EncryptFile(h.encKey, data)
		if err != nil {
			return 0, err
		}
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		return 0, err
	}
	return plainSize, nil
}

// readDecryptedFile serves a file that may have been written by writeEncryptedFile.
// When h.encKey is nil it falls back to http.ServeFile (no encryption).
// If decryption fails (legacy plaintext file) the raw bytes are served as-is,
// allowing the server to handle a mixed encrypted/unencrypted uploads directory
// during a migration window.
func (h *Handler) readDecryptedFile(w http.ResponseWriter, r *http.Request, path string) {
	if h.encKey == nil {
		http.ServeFile(w, r, path)
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	plain, err := crypto.DecryptFile(h.encKey, data)
	if err != nil {
		// Legacy unencrypted file — serve raw bytes.
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.Write(data)
		return
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(plain)))
	w.Write(plain)
}
