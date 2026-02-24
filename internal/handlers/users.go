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
)

// --- Users ---

func (h *Handler) ListUsers(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	users, err := h.db.ListUsers()
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to list users")
		return
	}
	if users == nil {
		users = []db.User{}
	}
	ok(w, users)
}

func (h *Handler) ListMembers(w http.ResponseWriter, r *http.Request) {
	users, err := h.db.ListUsers()
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to list members")
		return
	}
	// Return only public fields
	type PublicUser struct {
		ID       string   `json:"id"`
		Username string   `json:"username"`
		Avatar   string   `json:"avatar"`
		IsOwner  bool     `json:"is_owner"`
		Roles    []db.Role `json:"roles"`
	}
	var members []PublicUser
	for _, u := range users {
		members = append(members, PublicUser{
			ID:       u.ID,
			Username: u.Username,
			Avatar:   u.Avatar,
			IsOwner:  u.IsOwner,
			Roles:    u.Roles,
		})
	}
	if members == nil {
		members = []PublicUser{}
	}
	ok(w, members)
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
	if err := h.db.UpdateUser(id, req.Username, req.Avatar); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to update user")
		return
	}
	u, _ := h.db.GetUserByID(id)
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
	target, err := h.db.GetUserByID(id)
	if err != nil {
		errResp(w, http.StatusNotFound, "user not found")
		return
	}
	if target.IsOwner {
		errResp(w, http.StatusForbidden, "cannot delete owner")
		return
	}
	if err := h.db.DeleteUser(id); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to delete user")
		return
	}
	ok(w, map[string]string{"message": "deleted"})
}

// --- Roles ---

func (h *Handler) ListRoles(w http.ResponseWriter, r *http.Request) {
	roles, err := h.db.ListRoles()
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to list roles")
		return
	}
	if roles == nil {
		roles = []db.Role{}
	}
	ok(w, roles)
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
	role, err := h.db.CreateRole(req.Name, req.Color, req.Permissions)
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
	if err := h.db.UpdateRole(id, req.Name, req.Color, req.Permissions); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to update role")
		return
	}
	role, _ := h.db.GetRoleByID(id)
	ok(w, role)
}

func (h *Handler) DeleteRole(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	id := chi.URLParam(r, "id")
	if err := h.db.DeleteRole(id); err != nil {
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
	if err := h.db.AssignRole(userID, roleID); err != nil {
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
	if err := h.db.RemoveRole(userID, roleID); err != nil {
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
	invites, err := h.db.ListInvites()
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to list invites")
		return
	}
	if invites == nil {
		invites = []db.Invite{}
	}
	ok(w, invites)
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

	inv, err := h.db.CreateInvite(u.ID, req.MaxUses, nil)
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
	if err := h.db.DeleteInvite(code); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to delete invite")
		return
	}
	ok(w, map[string]string{"message": "deleted"})
}

func (h *Handler) JoinWithInvite(w http.ResponseWriter, r *http.Request) {
	code := chi.URLParam(r, "code")
	inv, err := h.db.GetInviteByCode(code)
	if err != nil {
		errResp(w, http.StatusNotFound, "invite not found")
		return
	}
	// Fix #5: Check both use count and expiry via IsInviteValid.
	if !h.db.IsInviteValid(inv) {
		errResp(w, http.StatusForbidden, "invite is no longer valid")
		return
	}
	// Return invite info so frontend can show register form
	serverName, _ := h.db.GetSetting("server_name")
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
	}
	result := make(map[string]string)
	for _, k := range publicKeys {
		if v, err := h.db.GetSetting(k); err == nil {
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
	settings, err := h.db.GetAllSettings()
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
	}
	for k, v := range req {
		if allowed[k] {
			// Validate numeric fields
			if k == "max_upload_mb" {
				if n, err := strconv.Atoi(v); err != nil || n <= 0 {
					continue
				}
			}
			h.db.SetSetting(k, v)
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
	h.db.SetSetting("server_icon", iconURL)
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
	h.db.SetSetting("login_bg_image", bgURL)
	ok(w, map[string]string{"bg": bgURL})
}
