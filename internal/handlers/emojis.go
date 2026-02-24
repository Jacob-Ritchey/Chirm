package handlers

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"

	"chirm/internal/db"
)

// ListCustomEmojis returns all custom emojis (any authenticated user).
func (h *Handler) ListCustomEmojis(w http.ResponseWriter, r *http.Request) {
	emojis, err := h.db.ListCustomEmojis()
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to list emojis")
		return
	}
	ok(w, emojis)
}

// UploadCustomEmoji handles multipart emoji image upload (admin only).
func (h *Handler) UploadCustomEmoji(w http.ResponseWriter, r *http.Request) {
	u, isOk := h.requireAdmin(w, r)
	if !isOk {
		return
	}

	if err := r.ParseMultipartForm(4 << 20); err != nil {
		errResp(w, http.StatusBadRequest, "request too large")
		return
	}

	// Validate name
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		errResp(w, http.StatusBadRequest, "emoji name required")
		return
	}
	for _, c := range name {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_') {
			errResp(w, http.StatusBadRequest, "emoji name can only contain letters, numbers, underscores")
			return
		}
	}
	name = strings.ToLower(name)

	file, header, err := r.FormFile("image")
	if err != nil {
		errResp(w, http.StatusBadRequest, "image required")
		return
	}
	defer file.Close()

	mime := header.Header.Get("Content-Type")
	if !strings.HasPrefix(mime, "image/") {
		errResp(w, http.StatusBadRequest, "file must be an image")
		return
	}
	if header.Size > 256*1024 {
		errResp(w, http.StatusBadRequest, "emoji image must be under 256KB")
		return
	}

	ext := filepath.Ext(header.Filename)
	if ext == "" {
		ext = ".png"
	}
	filename := fmt.Sprintf("emoji_%s%s", db.NewID(), ext)

	uploadsDir := filepath.Join(h.dataDir, "uploads")
	if err := os.MkdirAll(uploadsDir, 0755); err != nil {
		errResp(w, http.StatusInternalServerError, "storage error")
		return
	}

	dst, err := os.Create(filepath.Join(uploadsDir, filename))
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to save file")
		return
	}
	defer dst.Close()
	if _, err := io.Copy(dst, file); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to write file")
		return
	}

	emoji, err := h.db.CreateCustomEmoji(name, filename, u.ID)
	if err != nil {
		os.Remove(filepath.Join(uploadsDir, filename))
		if strings.Contains(err.Error(), "UNIQUE") {
			errResp(w, http.StatusConflict, "an emoji with that name already exists")
			return
		}
		errResp(w, http.StatusInternalServerError, "failed to create emoji")
		return
	}

	h.hub.Broadcast(WSEvent{Type: "emoji.new", Data: emoji})
	created(w, emoji)
}

// DeleteCustomEmoji removes a custom emoji (admin only).
func (h *Handler) DeleteCustomEmoji(w http.ResponseWriter, r *http.Request) {
	_, isOk := h.requireAdmin(w, r)
	if !isOk {
		return
	}

	id := chi.URLParam(r, "id")
	filename, err := h.db.DeleteCustomEmoji(id)
	if err != nil {
		errResp(w, http.StatusNotFound, "emoji not found")
		return
	}

	uploadsDir := filepath.Join(h.dataDir, "uploads")
	os.Remove(filepath.Join(uploadsDir, filename))

	h.hub.Broadcast(WSEvent{Type: "emoji.delete", Data: map[string]string{"id": id}})
	ok(w, map[string]string{"message": "deleted"})
}
