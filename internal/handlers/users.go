package handlers

import (
	"encoding/json"
	"net/http"
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
	if inv.MaxUses > 0 && inv.Uses >= inv.MaxUses {
		errResp(w, http.StatusForbidden, "invite has been used up")
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

func (h *Handler) GetSettings(w http.ResponseWriter, r *http.Request) {
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
		"server_name":         true,
		"allow_registration":  true,
		"require_invite":      true,
		"server_description":  true,
		"max_upload_mb":       true,
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
