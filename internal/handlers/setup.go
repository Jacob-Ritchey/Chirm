package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
)

func (h *Handler) SetupStatus(w http.ResponseWriter, r *http.Request) {
	ok(w, map[string]bool{"setup_done": h.db.IsSetupDone()})
}

func (h *Handler) Setup(w http.ResponseWriter, r *http.Request) {
	if h.db.IsSetupDone() {
		errResp(w, http.StatusForbidden, "setup already complete")
		return
	}

	var req struct {
		ServerName        string `json:"server_name"`
		ServerDescription string `json:"server_description"`
		LoginBgColor      string `json:"login_bg_color"`
		AgreementEnabled  string `json:"agreement_enabled"`
		AgreementText     string `json:"agreement_text"`
		Username          string `json:"username"`
		Email             string `json:"email"`
		Password          string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}

	req.Username = strings.TrimSpace(req.Username)
	req.Email = strings.TrimSpace(req.Email)
	req.ServerName = strings.TrimSpace(req.ServerName)

	if req.Username == "" || req.Email == "" || req.Password == "" || req.ServerName == "" {
		errResp(w, http.StatusBadRequest, "all fields required")
		return
	}
	if len(req.Password) < 8 {
		errResp(w, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}

	hash, err := h.auth.HashPassword(req.Password)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to hash password")
		return
	}

	// Create owner account
	user, err := h.db.CreateUser(req.Username, req.Email, hash, true)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to create user: "+err.Error())
		return
	}

	// Create default @everyone role
	_, err = h.db.CreateRole("@everyone", "#99AAB5", 3) // READ | SEND
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to create default role")
		return
	}

	// Create default channel
	_, err = h.db.CreateChannel("general", "General discussion", "text", "", "")
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to create channel")
		return
	}

	// Save settings
	h.db.SetSetting("setup_done", "1")
	h.db.SetSetting("server_name", req.ServerName)
	h.db.SetSetting("allow_registration", "1")
	h.db.SetSetting("require_invite", "0")
	if req.ServerDescription != "" {
		h.db.SetSetting("server_description", req.ServerDescription)
	}
	if req.LoginBgColor != "" {
		h.db.SetSetting("login_bg_color", req.LoginBgColor)
	}
	if req.AgreementEnabled == "1" && req.AgreementText != "" {
		h.db.SetSetting("agreement_enabled", "1")
		h.db.SetSetting("agreement_text", req.AgreementText)
	}

	// Issue token
	token, err := h.auth.GenerateToken(user.ID, user.Username, user.IsOwner)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	setTokenCookie(w, r, token)
	created(w, map[string]interface{}{"user": user, "token": token})
}

func setTokenCookie(w http.ResponseWriter, r *http.Request, token string) {
	// Only set Secure flag when actually served over HTTPS.  Hardcoding
	// Secure: true caused Chrome to silently reject the cookie over plain
	// HTTP, making login appear completely broken on :8080.
	isSecure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
	http.SetCookie(w, &http.Cookie{
		Name:     "chirm_token",
		Value:    token,
		Path:     "/",
		MaxAge:   30 * 24 * 3600,
		HttpOnly: true,
		Secure:   isSecure,
		SameSite: http.SameSiteLaxMode,
	})
}
