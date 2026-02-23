package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Fix #11: Only allow safe, unambiguous characters in usernames.
var validUsername = regexp.MustCompile(`^[a-zA-Z0-9_.\-]{2,32}$`)

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

	setTokenCookie(w, r, token)
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
	// Fix #11: Restrict username to safe characters only.
	if !validUsername.MatchString(req.Username) {
		errResp(w, http.StatusBadRequest, "username may only contain letters, numbers, _ . -")
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
		// Fix #5: IsInviteValid checks both max uses and expiry.
		if !h.db.IsInviteValid(inv) {
			errResp(w, http.StatusForbidden, "invite code is no longer valid")
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

	// Notify all connected clients so their member sidebars update live.
	h.hub.Broadcast(WSEvent{
		Type: "member.new",
		Data: map[string]interface{}{
			"id":       u.ID,
			"username": u.Username,
			"avatar":   u.Avatar,
			"is_owner": u.IsOwner,
			"roles":    []interface{}{},
		},
	})

	setTokenCookie(w, r, token)
	created(w, map[string]interface{}{"user": u, "token": token})
}

func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	isSecure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
	http.SetCookie(w, &http.Cookie{
		Name:     "chirm_token",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   isSecure,
		SameSite: http.SameSiteLaxMode,
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

// UploadAvatar accepts a multipart image, saves it, and updates the user's avatar field.
func (h *Handler) UploadAvatar(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 5*1024*1024) // 5 MB cap for avatars
	if err := r.ParseMultipartForm(5 * 1024 * 1024); err != nil {
		errResp(w, http.StatusBadRequest, "file too large (max 5MB)")
		return
	}

	file, header, err := r.FormFile("avatar")
	if err != nil {
		errResp(w, http.StatusBadRequest, "no file provided")
		return
	}
	defer file.Close()

	// Detect type from first 512 bytes
	buf := make([]byte, 512)
	n, _ := file.Read(buf)
	mimeType := http.DetectContentType(buf[:n])

	allowedAvatarTypes := map[string]bool{
		"image/jpeg": true,
		"image/png":  true,
		"image/gif":  true,
		"image/webp": true,
	}
	if !allowedAvatarTypes[mimeType] {
		errResp(w, http.StatusBadRequest, "avatar must be JPEG, PNG, GIF or WebP")
		return
	}

	// Seek back, then save
	file.Seek(0, 0)

	// Generate unique filename
	ext := filepath.Ext(header.Filename)
	if ext == "" {
		ext = ".jpg"
	}
	filename := "avatar_" + newID() + ext
	destPath := filepath.Join(h.dataDir, "uploads", filename)

	dest, err := os.Create(destPath)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to save avatar")
		return
	}
	defer dest.Close()
	if _, err := io.Copy(dest, file); err != nil {
		os.Remove(destPath)
		errResp(w, http.StatusInternalServerError, "failed to write avatar")
		return
	}

	avatarURL := "/uploads/" + filename
	if err := h.db.UpdateUser(u.ID, u.Username, avatarURL); err != nil {
		os.Remove(destPath)
		errResp(w, http.StatusInternalServerError, "failed to update avatar")
		return
	}

	updated, _ := h.db.GetUserByID(u.ID)
	ok(w, updated)
}

