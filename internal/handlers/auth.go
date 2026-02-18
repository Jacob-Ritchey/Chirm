package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
)

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Login    string `json:"login"` // username or email
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}

	u, err := h.db.GetUserByUsername(req.Login)
	if err != nil {
		u, err = h.db.GetUserByEmail(req.Login)
		if err != nil {
			errResp(w, http.StatusUnauthorized, "invalid credentials")
			return
		}
	}

	if !h.auth.CheckPassword(u.PasswordHash, req.Password) {
		errResp(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	token, err := h.auth.GenerateToken(u.ID, u.Username, u.IsOwner)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	setTokenCookie(w, token)
	ok(w, map[string]interface{}{"user": u, "token": token})
}

func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	// Check if registration is allowed
	allowReg, _ := h.db.GetSetting("allow_registration")
	requireInvite, _ := h.db.GetSetting("require_invite")

	if allowReg != "1" {
		errResp(w, http.StatusForbidden, "registration is disabled")
		return
	}

	var req struct {
		Username   string `json:"username"`
		Email      string `json:"email"`
		Password   string `json:"password"`
		InviteCode string `json:"invite_code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}

	req.Username = strings.TrimSpace(req.Username)
	req.Email = strings.TrimSpace(req.Email)

	if req.Username == "" || req.Email == "" || req.Password == "" {
		errResp(w, http.StatusBadRequest, "all fields required")
		return
	}
	if len(req.Password) < 8 {
		errResp(w, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}
	if len(req.Username) < 2 || len(req.Username) > 32 {
		errResp(w, http.StatusBadRequest, "username must be 2-32 characters")
		return
	}

	// Check invite requirement
	if requireInvite == "1" {
		if req.InviteCode == "" {
			errResp(w, http.StatusForbidden, "invite code required")
			return
		}
		inv, err := h.db.GetInviteByCode(req.InviteCode)
		if err != nil {
			errResp(w, http.StatusForbidden, "invalid invite code")
			return
		}
		if inv.MaxUses > 0 && inv.Uses >= inv.MaxUses {
			errResp(w, http.StatusForbidden, "invite code has been used up")
			return
		}
		h.db.UseInvite(req.InviteCode)
	}

	hash, err := h.auth.HashPassword(req.Password)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to hash password")
		return
	}

	u, err := h.db.CreateUser(req.Username, req.Email, hash, false)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			errResp(w, http.StatusConflict, "username or email already taken")
			return
		}
		errResp(w, http.StatusInternalServerError, "failed to create user")
		return
	}

	token, err := h.auth.GenerateToken(u.ID, u.Username, u.IsOwner)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	setTokenCookie(w, token)
	created(w, map[string]interface{}{"user": u, "token": token})
}

func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:   "nexus_token",
		Value:  "",
		Path:   "/",
		MaxAge: -1,
	})
	ok(w, map[string]string{"message": "logged out"})
}

func (h *Handler) GetMe(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	ok(w, u)
}

func (h *Handler) UpdateMe(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req struct {
		Username string `json:"username"`
		Avatar   string `json:"avatar"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}

	username := strings.TrimSpace(req.Username)
	if username == "" {
		username = u.Username
	}

	if err := h.db.UpdateUser(u.ID, username, req.Avatar); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to update user")
		return
	}

	updated, _ := h.db.GetUserByID(u.ID)
	ok(w, updated)
}
