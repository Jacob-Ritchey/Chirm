package handlers

import (
	"bufio"
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	authpkg "chirm/internal/auth"
	"chirm/internal/db"
	"chirm/internal/events"
	"chirm/internal/logger"
)

// checkPasswordPolicy validates a password against Chirm's strength requirements.
// Returns a non-empty error message string on failure.
func checkPasswordPolicy(password string) string {
	if len(password) < 10 {
		return "password must be at least 10 characters"
	}
	// Reject passwords that are all the same character.
	allSame := true
	for _, c := range password[1:] {
		if c != rune(password[0]) {
			allSame = false
			break
		}
	}
	if allSame {
		return "password is too simple"
	}
	// Require at least one non-letter character.
	hasNonLetter := false
	for _, c := range password {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
			hasNonLetter = true
			break
		}
	}
	if !hasNonLetter {
		return "password must contain at least one non-letter character"
	}
	return ""
}

// checkHIBP checks the password against the HaveIBeenPwned k-anonymity API.
// Returns true if the password appears in a known breach. Silently passes on
// network errors to avoid blocking registration when HIBP is unreachable.
func checkHIBP(password string) bool {
	sum := sha1.Sum([]byte(password))
	hash := fmt.Sprintf("%X", sum)
	prefix, suffix := hash[:5], hash[5:]

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("https://api.pwnedpasswords.com/range/" + prefix)
	if err != nil {
		return false // network unavailable — allow through
	}
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.SplitN(line, ":", 2)
		if len(parts) == 2 && strings.EqualFold(parts[0], suffix) {
			return true
		}
	}
	return false
}

// adminUnlockAccount allows the server owner to clear a login lockout.
func (h *Handler) AdminUnlockAccount(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	identifier := chi.URLParam(r, "identifier")
	if identifier == "" {
		errResp(w, http.StatusBadRequest, "identifier required")
		return
	}
	h.store.UnlockIdentifier(identifier)
	ok(w, map[string]string{"message": "account unlocked"})
}

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

	// Check lockout before any DB lookup to prevent user enumeration via timing.
	if locked, until := h.store.IsLocked(req.Login); locked {
		w.Header().Set("Retry-After", fmt.Sprintf("%d", int(time.Until(until).Seconds())))
		logger.Audit("login_locked", "identifier", req.Login, "ip", r.RemoteAddr)
		errResp(w, http.StatusTooManyRequests, "account temporarily locked due to too many failed attempts")
		return
	}

	u, err := h.store.GetUserByUsername(req.Login)
	if err != nil {
		u, err = h.store.GetUserByEmail(req.Login)
		if err != nil {
			h.store.RecordFailedLogin(req.Login)
			logger.Audit("login_failed", "identifier", req.Login, "ip", r.RemoteAddr)
			errResp(w, http.StatusUnauthorized, "invalid credentials")
			return
		}
	}

	if !h.auth.CheckPassword(u.PasswordHash, req.Password) {
		h.store.RecordFailedLogin(req.Login)
		logger.Audit("login_failed", "identifier", req.Login, "ip", r.RemoteAddr)
		errResp(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	h.store.ClearLoginAttempts(req.Login)

	// If TOTP is enabled, issue a pending session and require a second step.
	_, totpEnabled := h.store.GetTOTPSecret(u.ID)
	if totpEnabled {
		pendingToken, err := h.store.CreateTOTPPendingSession(u.ID)
		if err != nil {
			errResp(w, http.StatusInternalServerError, "failed to create 2FA session")
			return
		}
		logger.Audit("login_2fa_required", "user_id", u.ID, "ip", r.RemoteAddr)
		// Return 202 Accepted — the client must complete the TOTP step.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":            true,
			"data":          map[string]interface{}{"totp_required": true, "pending_token": pendingToken},
		})
		return
	}

	logger.Audit("login_ok", "user_id", u.ID, "ip", r.RemoteAddr)

	token, err := h.auth.GenerateToken(u.ID, u.Username, u.IsOwner)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	refreshToken, err := h.store.CreateRefreshToken(u.ID)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to create session")
		return
	}

	setTokenCookie(w, r, token)
	setRefreshCookie(w, r, refreshToken)
	ok(w, map[string]interface{}{"user": u, "token": token})
}

func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	// Check if registration is allowed
	allowReg, _ := h.store.GetSetting("allow_registration")
	requireInvite, _ := h.store.GetSetting("require_invite")

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
	if msg := checkPasswordPolicy(req.Password); msg != "" {
		errResp(w, http.StatusBadRequest, msg)
		return
	}

	// HIBP check — only skip if explicitly disabled via setting.
	hibpEnabled, _ := h.store.GetSetting("hibp_check_enabled")
	if hibpEnabled != "0" {
		if checkHIBP(req.Password) {
			errResp(w, http.StatusBadRequest, "this password has appeared in a known data breach; please choose a different password")
			return
		}
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
		inv, err := h.store.GetInviteByCode(req.InviteCode)
		if err != nil {
			errResp(w, http.StatusForbidden, "invalid invite code")
			return
		}
		// Fix #5: IsInviteValid checks both max uses and expiry.
		if !h.store.IsInviteValid(inv) {
			errResp(w, http.StatusForbidden, "invite code is no longer valid")
			return
		}
		h.store.UseInvite(req.InviteCode)
		h.store.TruncateInviteChain(req.InviteCode)
	}

	hash, err := h.auth.HashPassword(req.Password)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to hash password")
		return
	}

	u, err := h.store.CreateUser(req.Username, req.Email, hash, false)
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

	refreshToken, err := h.store.CreateRefreshToken(u.ID)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to create session")
		return
	}

	h.bus.Publish(events.Event{Type: events.UserJoined, Data: events.UserJoinedData{User: u}})

	logger.Audit("register_ok", "user_id", u.ID, "ip", r.RemoteAddr)
	setTokenCookie(w, r, token)
	setRefreshCookie(w, r, refreshToken)
	created(w, map[string]interface{}{"user": u, "token": token})
}

// RefreshToken exchanges a valid refresh token cookie for a new access JWT
// and rotates the refresh token (old one is invalidated, new one issued).
func (h *Handler) RefreshToken(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("chirm_refresh")
	if err != nil || cookie.Value == "" {
		errResp(w, http.StatusUnauthorized, "no refresh token")
		return
	}

	userID, newRefreshRaw, err := h.store.RotateRefreshToken(cookie.Value)
	if err != nil {
		errResp(w, http.StatusUnauthorized, "invalid or expired refresh token")
		return
	}

	u, err := h.store.GetUserByID(userID)
	if err != nil {
		errResp(w, http.StatusUnauthorized, "user not found")
		return
	}

	newToken, err := h.auth.GenerateToken(u.ID, u.Username, u.IsOwner)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	setTokenCookie(w, r, newToken)
	setRefreshCookie(w, r, newRefreshRaw)
	ok(w, map[string]interface{}{"token": newToken})
}

func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	isSecure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"

	// Revoke refresh token stored in cookie if present.
	if cookie, err := r.Cookie("chirm_token"); err == nil {
		if claims, err := h.auth.ValidateToken(cookie.Value); err == nil {
			h.store.RevokeRefreshTokensForUser(claims.UserID)
		}
	}

	// Clear both cookies.
	http.SetCookie(w, &http.Cookie{
		Name:     "chirm_token",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   isSecure,
		SameSite: http.SameSiteLaxMode,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     "chirm_refresh",
		Value:    "",
		Path:     "/api/v1/auth/refresh",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   isSecure,
		SameSite: http.SameSiteLaxMode,
	})
	ok(w, map[string]string{"message": "logged out"})
}

// VerifyTOTP completes the second step of login. The client sends the
// pending_token from the first step and a 6-digit TOTP code (or backup code).
func (h *Handler) VerifyTOTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PendingToken string `json:"pending_token"`
		Code         string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}

	userID := h.store.ConsumeTOTPPendingSession(req.PendingToken)
	if userID == "" {
		logger.Audit("totp_verify_failed", "reason", "invalid_pending_token", "ip", r.RemoteAddr)
		errResp(w, http.StatusUnauthorized, "invalid or expired 2FA session")
		return
	}

	secret, enabled := h.store.GetTOTPSecret(userID)
	if !enabled {
		errResp(w, http.StatusBadRequest, "2FA is not enabled for this account")
		return
	}

	valid := authpkg.ValidateTOTP(secret, req.Code)
	if !valid {
		// Try backup code.
		valid = h.store.UseBackupCode(userID, strings.ToUpper(strings.ReplaceAll(req.Code, " ", "")))
	}
	if !valid {
		logger.Audit("totp_verify_failed", "user_id", userID, "ip", r.RemoteAddr)
		errResp(w, http.StatusUnauthorized, "invalid 2FA code")
		return
	}

	u, err := h.store.GetUserByID(userID)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "user not found")
		return
	}

	token, err := h.auth.GenerateToken(u.ID, u.Username, u.IsOwner)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to generate token")
		return
	}
	refreshToken, err := h.store.CreateRefreshToken(u.ID)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to create session")
		return
	}

	logger.Audit("login_ok_2fa", "user_id", u.ID, "ip", r.RemoteAddr)
	setTokenCookie(w, r, token)
	setRefreshCookie(w, r, refreshToken)
	ok(w, map[string]interface{}{"user": u, "token": token})
}

// SetupTOTP generates a new TOTP secret and returns the provisioning URI.
// The secret is stored but totp_enabled remains false until confirmed.
func (h *Handler) SetupTOTP(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	secret, err := authpkg.GenerateTOTPSecret()
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to generate secret")
		return
	}

	if err := h.store.SetTOTPSecret(u.ID, secret); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to store secret")
		return
	}

	uri := authpkg.TOTPProvisioningURI(secret, u.Username, "Chirm")
	ok(w, map[string]string{"secret": secret, "uri": uri})
}

// ConfirmTOTP activates TOTP for the user after verifying a valid code.
func (h *Handler) ConfirmTOTP(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}

	secret, _ := h.store.GetTOTPSecret(u.ID)
	if secret == "" {
		errResp(w, http.StatusBadRequest, "run TOTP setup first")
		return
	}
	if !authpkg.ValidateTOTP(secret, req.Code) {
		errResp(w, http.StatusUnauthorized, "invalid code")
		return
	}

	backupCodes, err := h.store.ConfirmTOTP(u.ID)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to enable 2FA")
		return
	}

	logger.Audit("totp_enabled", "user_id", u.ID)
	ok(w, map[string]interface{}{"backup_codes": backupCodes})
}

// DisableTOTP removes TOTP from the user's account after verifying a valid code.
func (h *Handler) DisableTOTP(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}

	secret, enabled := h.store.GetTOTPSecret(u.ID)
	if !enabled {
		errResp(w, http.StatusBadRequest, "2FA is not enabled")
		return
	}
	if !authpkg.ValidateTOTP(secret, req.Code) {
		errResp(w, http.StatusUnauthorized, "invalid code")
		return
	}

	if err := h.store.DisableTOTP(u.ID); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to disable 2FA")
		return
	}

	logger.Audit("totp_disabled", "user_id", u.ID)
	ok(w, map[string]string{"message": "2FA disabled"})
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

	if err := h.store.UpdateUserProfile(u.ID, username, req.Avatar, bio, links); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to update user")
		return
	}

	// Banner field: update only when explicitly provided
	if req.Banner != nil {
		h.store.UpdateUserBanner(u.ID, *req.Banner)
	}

	updated, _ := h.store.GetUserByID(u.ID)

	go h.store.PropagateProfileUpdate(updated.ID, updated.Username, updated.Avatar)

	h.bus.Publish(events.Event{
		Type: events.UserProfileChanged,
		Data: events.UserProfileChangedData{UserID: updated.ID, Username: updated.Username, Avatar: updated.Avatar},
	})

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

	if _, err := h.writeEncryptedFile(destPath, file); err != nil {
		os.Remove(destPath)
		errResp(w, http.StatusInternalServerError, "failed to write avatar")
		return
	}

	avatarURL := "/api/v1/uploads/" + filename
	if err := h.store.UpdateUser(u.ID, u.Username, avatarURL); err != nil {
		os.Remove(destPath)
		errResp(w, http.StatusInternalServerError, "failed to update avatar")
		return
	}

	updated, _ := h.store.GetUserByID(u.ID)

	go h.store.PropagateProfileUpdate(updated.ID, updated.Username, updated.Avatar)

	h.bus.Publish(events.Event{
		Type: events.UserProfileChanged,
		Data: events.UserProfileChangedData{UserID: updated.ID, Username: updated.Username, Avatar: updated.Avatar},
	})

	ok(w, updated)
}

// UploadBanner accepts a multipart image and saves it as the user's profile banner.
func (h *Handler) UploadBanner(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	maxMBStr, _ := h.store.GetSetting("max_upload_mb")
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

	if _, err := h.writeEncryptedFile(destPath, file); err != nil {
		os.Remove(destPath)
		errResp(w, http.StatusInternalServerError, "failed to write banner")
		return
	}

	bannerURL := "/api/v1/uploads/" + filename
	if err := h.store.UpdateUserBanner(u.ID, bannerURL); err != nil {
		os.Remove(destPath)
		errResp(w, http.StatusInternalServerError, "failed to update banner")
		return
	}

	updated, _ := h.store.GetUserByID(u.ID)
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

	if err := h.store.UpdateUserStatus(u.ID, req.Status); err != nil {
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
	u, err := h.store.GetUserByID(userID)
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

