package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"chirm/internal/db"
	"chirm/internal/events"
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

	h.bus.Publish(events.Event{Type: events.UserJoined, Data: events.UserJoinedData{User: u}})

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
		Username   string  `json:"username"`
		Avatar     string  `json:"avatar"`
		Bio        string  `json:"bio"`
		Links      string  `json:"links"`
		Banner     *string `json:"banner"` // pointer so we can detect explicit empty-string (clear)
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}

	username := strings.TrimSpace(req.Username)
	if username == "" {
		username = u.Username
	}

	bio := req.Bio
	if len(bio) > 500 {
		bio = bio[:500]
	}

	links := req.Links
	if links == "" {
		links = "[]"
	}

	if err := h.db.UpdateUserProfile(u.ID, username, req.Avatar, bio, links); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to update user")
		return
	}

	// Banner field: update only when explicitly provided
	if req.Banner != nil {
		h.db.UpdateUserBanner(u.ID, *req.Banner)
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

// UploadBanner accepts a multipart image and saves it as the user's profile banner.
func (h *Handler) UploadBanner(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

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

	file, header, err := r.FormFile("banner")
	if err != nil {
		errResp(w, http.StatusBadRequest, "no file provided")
		return
	}
	defer file.Close()

	buf := make([]byte, 512)
	n, _ := file.Read(buf)
	mimeType := http.DetectContentType(buf[:n])

	allowedBannerTypes := map[string]bool{
		"image/jpeg": true,
		"image/png":  true,
		"image/gif":  true,
		"image/webp": true,
	}
	if !allowedBannerTypes[mimeType] {
		errResp(w, http.StatusBadRequest, "banner must be JPEG, PNG, GIF or WebP")
		return
	}

	file.Seek(0, 0)

	ext := filepath.Ext(header.Filename)
	if ext == "" {
		ext = ".jpg"
	}
	filename := "banner_" + newID() + ext
	destPath := filepath.Join(h.dataDir, "uploads", filename)

	dest, err := os.Create(destPath)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to save banner")
		return
	}
	defer dest.Close()
	if _, err := io.Copy(dest, file); err != nil {
		os.Remove(destPath)
		errResp(w, http.StatusInternalServerError, "failed to write banner")
		return
	}

	bannerURL := "/uploads/" + filename
	if err := h.db.UpdateUserBanner(u.ID, bannerURL); err != nil {
		os.Remove(destPath)
		errResp(w, http.StatusInternalServerError, "failed to update banner")
		return
	}

	updated, _ := h.db.GetUserByID(u.ID)
	ok(w, updated)
}

// UpdateStatus sets the current user's online status (online | away | dnd).
func (h *Handler) UpdateStatus(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}

	validStatuses := map[string]bool{"online": true, "away": true, "dnd": true, "invisible": true}
	if !validStatuses[req.Status] {
		errResp(w, http.StatusBadRequest, "status must be one of: online, away, dnd, invisible")
		return
	}

	if err := h.db.UpdateUserStatus(u.ID, req.Status); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to update status")
		return
	}

	h.bus.Publish(events.Event{
		Type: events.UserStatusChanged,
		Data: events.UserStatusChangedData{UserID: u.ID, Status: req.Status},
	})

	ok(w, map[string]string{"status": req.Status})
}

// GetUserProfile returns public profile fields for any user by ID.
func (h *Handler) GetUserProfile(w http.ResponseWriter, r *http.Request) {
	_, err := h.currentUser(r)
	if err != nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	userID := chi.URLParam(r, "id")
	u, err := h.db.GetUserByID(userID)
	if err != nil {
		errResp(w, http.StatusNotFound, "user not found")
		return
	}

	type PublicProfile struct {
		ID        string    `json:"id"`
		Username  string    `json:"username"`
		Avatar    string    `json:"avatar"`
		Bio       string    `json:"bio"`
		Links     string    `json:"links"`
		Banner    string    `json:"banner"`
		Status    string    `json:"status"`
		IsOwner   bool      `json:"is_owner"`
		Roles     []db.Role `json:"roles"`
		CreatedAt time.Time `json:"created_at"`
	}

	publicStatus := u.Status
	if publicStatus == "invisible" {
		publicStatus = "offline"
	}

	ok(w, PublicProfile{
		ID:        u.ID,
		Username:  u.Username,
		Avatar:    u.Avatar,
		Bio:       u.Bio,
		Links:     u.Links,
		Banner:    u.Banner,
		Status:    publicStatus,
		IsOwner:   u.IsOwner,
		Roles:     u.Roles,
		CreatedAt: u.CreatedAt,
	})
}

