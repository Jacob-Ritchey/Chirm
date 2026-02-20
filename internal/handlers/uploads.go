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
	maxMBStr, _ := h.db.GetSetting("max_upload_mb")
	maxMB := int64(25)
	if n, err := strconv.ParseInt(maxMBStr, 10, 64); err == nil && n > 0 {
		maxMB = n
	}
	maxBytes := maxMB * 1024 * 1024

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

	dest, err := os.Create(destPath)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to save file")
		return
	}
	defer dest.Close()

	size, err := io.Copy(dest, file)
	if err != nil {
		os.Remove(destPath)
		errResp(w, http.StatusInternalServerError, "failed to write file")
		return
	}

	// Create attachment record (message_id will be "" until attached to a message)
	att, err := h.db.CreateAttachment("", filename, header.Filename, mimeType, size)
	if err != nil {
		os.Remove(destPath)
		errResp(w, http.StatusInternalServerError, "failed to record upload")
		return
	}

	created(w, map[string]interface{}{
		"id":            att.ID,
		"filename":      filename,
		"original_name": header.Filename,
		"mime_type":     mimeType,
		"size":          size,
		"url":           "/uploads/" + filename,
	})
}

func (h *Handler) ServeUpload(w http.ResponseWriter, r *http.Request) {
	filename := chi.URLParam(r, "filename")
	// Sanitize
	filename = filepath.Base(filename)
	if strings.Contains(filename, "..") {
		http.Error(w, "invalid filename", http.StatusBadRequest)
		return
	}
	path := filepath.Join(h.dataDir, "uploads", filename)

	// Fix #2: Force download and prevent MIME-sniffing so browsers never
	// execute content (especially important for any future edge-case types).
	w.Header().Set("Content-Disposition", "attachment; filename=\""+filename+"\"")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, path)
}

// newID generates a random hex ID for filenames
func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}
