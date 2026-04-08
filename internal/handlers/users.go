package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"github.com/go-chi/chi/v5"

	"chirm/internal/db"
	"chirm/internal/events"
)

// --- Users ---

func (h *Handler) ListUsers(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	before, limit := parsePagination(r)
	items, err := h.store.ListUsersPaginated(before, limit+1)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to list users")
		return
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	if items == nil {
		items = []db.User{}
	}
	ok(w, map[string]interface{}{"items": items, "has_more": hasMore})
}

func (h *Handler) ListMembers(w http.ResponseWriter, r *http.Request) {
	before, limit := parsePagination(r)
	users, err := h.store.ListUsersPaginated(before, limit+1)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to list members")
		return
	}
	hasMore := len(users) > limit
	if hasMore {
		users = users[:limit]
	}
	// Return only public fields
	type PublicUser struct {
		ID       string    `json:"id"`
		Username string    `json:"username"`
		Avatar   string    `json:"avatar"`
		IsOwner  bool      `json:"is_owner"`
		Roles    []db.Role `json:"roles"`
	}
	items := make([]PublicUser, 0, len(users))
	for _, u := range users {
		items = append(items, PublicUser{
			ID:       u.ID,
			Username: u.Username,
			Avatar:   u.Avatar,
			IsOwner:  u.IsOwner,
			Roles:    u.Roles,
		})
	}
	ok(w, map[string]interface{}{"items": items, "has_more": hasMore})
}

func (h *Handler) UpdateUser(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	id := chi.URLParam(r, "id")
	var req struct {
		Username string `json:"username"`
		Avatar   string `json:"avatar"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}
	if err := h.store.UpdateUser(id, req.Username, req.Avatar); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to update user")
		return
	}
	u, _ := h.store.GetUserByID(id)
	ok(w, u)
}

func (h *Handler) DeleteUser(w http.ResponseWriter, r *http.Request) {
	admin, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	id := chi.URLParam(r, "id")
	if id == admin.ID {
		errResp(w, http.StatusBadRequest, "cannot delete yourself")
		return
	}
	target, err := h.store.GetUserByID(id)
	if err != nil {
		errResp(w, http.StatusNotFound, "user not found")
		return
	}
	if target.IsOwner {
		errResp(w, http.StatusForbidden, "cannot delete owner")
		return
	}
	if err := h.store.DeleteUser(id); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to delete user")
		return
	}
	h.bus.Publish(events.Event{Type: events.UserLeft, Data: events.UserLeftData{UserID: id}})
	ok(w, map[string]string{"message": "deleted"})
}

// --- Roles ---

func (h *Handler) ListRoles(w http.ResponseWriter, r *http.Request) {
	before, limit := parsePagination(r)
	items, err := h.store.ListRolesPaginated(before, limit+1)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to list roles")
		return
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	if items == nil {
		items = []db.Role{}
	}
	ok(w, map[string]interface{}{"items": items, "has_more": hasMore})
}

func (h *Handler) CreateRole(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	var req struct {
		Name        string `json:"name"`
		Color       string `json:"color"`
		Permissions int    `json:"permissions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.Name == "" {
		errResp(w, http.StatusBadRequest, "name required")
		return
	}
	if req.Color == "" {
		req.Color = "#99AAB5"
	}
	role, err := h.store.CreateRole(req.Name, req.Color, req.Permissions)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to create role")
		return
	}
	created(w, role)
}

func (h *Handler) UpdateRole(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	id := chi.URLParam(r, "id")
	var req struct {
		Name        string `json:"name"`
		Color       string `json:"color"`
		Permissions int    `json:"permissions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}
	if err := h.store.UpdateRole(id, req.Name, req.Color, req.Permissions); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to update role")
		return
	}
	role, _ := h.store.GetRoleByID(id)
	ok(w, role)
}

func (h *Handler) DeleteRole(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	id := chi.URLParam(r, "id")
	if err := h.store.DeleteRole(id); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to delete role")
		return
	}
	ok(w, map[string]string{"message": "deleted"})
}

func (h *Handler) AssignRole(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	userID := chi.URLParam(r, "id")
	roleID := chi.URLParam(r, "roleId")
	if err := h.store.AssignRole(userID, roleID); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to assign role")
		return
	}
	ok(w, map[string]string{"message": "assigned"})
}

func (h *Handler) RemoveRole(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	userID := chi.URLParam(r, "id")
	roleID := chi.URLParam(r, "roleId")
	if err := h.store.RemoveRole(userID, roleID); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to remove role")
		return
	}
	ok(w, map[string]string{"message": "removed"})
}

// --- Invites ---

func (h *Handler) ListInvites(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	before, limit := parsePagination(r)
	items, err := h.store.ListInvitesPaginated(before, limit+1)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to list invites")
		return
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	if items == nil {
		items = []db.Invite{}
	}
	ok(w, map[string]interface{}{"items": items, "has_more": hasMore})
}

func (h *Handler) CreateInvite(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req struct {
		MaxUses int `json:"max_uses"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	inv, err := h.store.CreateInvite(u.ID, req.MaxUses, nil)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to create invite")
		return
	}
	created(w, inv)
}

func (h *Handler) DeleteInvite(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	code := chi.URLParam(r, "code")
	if err := h.store.DeleteInvite(code); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to delete invite")
		return
	}
	ok(w, map[string]string{"message": "deleted"})
}

func (h *Handler) JoinWithInvite(w http.ResponseWriter, r *http.Request) {
	code := chi.URLParam(r, "code")
	inv, err := h.store.GetInviteByCode(code)
	if err != nil {
		errResp(w, http.StatusNotFound, "invite not found")
		return
	}
	// Fix #5: Check both use count and expiry via IsInviteValid.
	if !h.store.IsInviteValid(inv) {
		errResp(w, http.StatusForbidden, "invite is no longer valid")
		return
	}
	// Return invite info so frontend can show register form
	serverName, _ := h.store.GetSetting("server_name")
	ok(w, map[string]interface{}{
		"valid":       true,
		"code":        code,
		"server_name": serverName,
	})
}

// --- Settings ---

// GetPublicSettings returns non-sensitive settings accessible without authentication.
// Used by login page and mobile sidebar to show server branding.
func (h *Handler) GetPublicSettings(w http.ResponseWriter, r *http.Request) {
	publicKeys := []string{
		"server_name", "server_description", "server_icon",
		"login_bg_color", "login_bg_image", "login_bg_overlay",
		"require_invite", "allow_registration",
		"agreement_enabled", "agreement_text",
		"theme_css_vars",
	}
	result := make(map[string]string)
	for _, k := range publicKeys {
		if v, err := h.store.GetSetting(k); err == nil {
			result[k] = v
		}
	}
	ok(w, result)
}

func (h *Handler) GetSettings(w http.ResponseWriter, r *http.Request) {
	// Fix #12: Settings are admin-only — they expose operational configuration.
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	settings, err := h.store.GetAllSettings()
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to get settings")
		return
	}
	// Remove internal keys
	delete(settings, "setup_done")
	ok(w, settings)
}

func (h *Handler) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	var req map[string]string
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}
	allowed := map[string]bool{
		"server_name":        true,
		"allow_registration": true,
		"require_invite":     true,
		"server_description": true,
		"max_upload_mb":      true,
		"server_icon":        true,
		"login_bg_color":     true,
		"login_bg_image":     true,
		"login_bg_overlay":   true,
		"agreement_enabled":  true,
		"agreement_text":     true,
		"theme_css_vars":     true,
	}
	for k, v := range req {
		if allowed[k] {
			// Validate numeric fields
			if k == "max_upload_mb" {
				if n, err := strconv.Atoi(v); err != nil || n <= 0 {
					continue
				}
			}
			h.store.SetSetting(k, v)
		}
	}
	ok(w, map[string]string{"message": "settings updated"})
}

// UploadServerIcon accepts a multipart image, saves it, and stores the URL in server settings.
func (h *Handler) UploadServerIcon(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 5*1024*1024) // 5 MB cap
	if err := r.ParseMultipartForm(5 * 1024 * 1024); err != nil {
		errResp(w, http.StatusBadRequest, "file too large (max 5MB)")
		return
	}

	file, header, err := r.FormFile("icon")
	if err != nil {
		errResp(w, http.StatusBadRequest, "no file provided")
		return
	}
	defer file.Close()

	buf := make([]byte, 512)
	n, _ := file.Read(buf)
	mimeType := http.DetectContentType(buf[:n])
	allowed := map[string]bool{"image/jpeg": true, "image/png": true, "image/gif": true, "image/webp": true}
	if !allowed[mimeType] {
		errResp(w, http.StatusBadRequest, "icon must be JPEG, PNG, GIF or WebP")
		return
	}
	file.Seek(0, 0)

	ext := filepath.Ext(header.Filename)
	if ext == "" {
		ext = ".png"
	}
	filename := "server_icon_" + newID() + ext
	destPath := filepath.Join(h.dataDir, "uploads", filename)

	dest, err := os.Create(destPath)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to save icon")
		return
	}
	defer dest.Close()
	if _, err := io.Copy(dest, file); err != nil {
		os.Remove(destPath)
		errResp(w, http.StatusInternalServerError, "failed to write icon")
		return
	}

	iconURL := "/uploads/" + filename
	h.store.SetSetting("server_icon", iconURL)
	ok(w, map[string]string{"icon": iconURL})
}

// UploadLoginBg accepts a multipart image for the login page background.
func (h *Handler) UploadLoginBg(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 10*1024*1024) // 10 MB cap
	if err := r.ParseMultipartForm(10 * 1024 * 1024); err != nil {
		errResp(w, http.StatusBadRequest, "file too large (max 10MB)")
		return
	}

	file, header, err := r.FormFile("bg")
	if err != nil {
		errResp(w, http.StatusBadRequest, "no file provided")
		return
	}
	defer file.Close()

	buf := make([]byte, 512)
	n, _ := file.Read(buf)
	mimeType := http.DetectContentType(buf[:n])
	allowed := map[string]bool{"image/jpeg": true, "image/png": true, "image/gif": true, "image/webp": true}
	if !allowed[mimeType] {
		errResp(w, http.StatusBadRequest, "background must be JPEG, PNG, GIF or WebP")
		return
	}
	file.Seek(0, 0)

	ext := filepath.Ext(header.Filename)
	if ext == "" {
		ext = ".jpg"
	}
	filename := "login_bg_" + newID() + ext
	destPath := filepath.Join(h.dataDir, "uploads", filename)

	dest, err := os.Create(destPath)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to save background")
		return
	}
	defer dest.Close()
	if _, err := io.Copy(dest, file); err != nil {
		os.Remove(destPath)
		errResp(w, http.StatusInternalServerError, "failed to write background")
		return
	}

	bgURL := "/uploads/" + filename
	h.store.SetSetting("login_bg_image", bgURL)
	ok(w, map[string]string{"bg": bgURL})
}
