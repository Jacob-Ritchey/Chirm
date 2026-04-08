package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/gorilla/websocket"

	"chirm/internal/auth"
	"chirm/internal/db"
	"chirm/internal/events"
	"chirm/internal/hub"
	mw "chirm/internal/middleware"
)

type Handler struct {
	db            *db.DB
	auth          *auth.Service
	hub           *hub.Hub
	bus           *events.Bus
	dataDir       string
	allowedOrigin string
}

func New(database *db.DB, authSvc *auth.Service, h *hub.Hub, bus *events.Bus, dataDir, allowedOrigin string) *Handler {
	return &Handler{db: database, auth: authSvc, hub: h, bus: bus, dataDir: dataDir, allowedOrigin: allowedOrigin}
}

// makeUpgrader builds a WebSocket upgrader that validates the Origin header.
func makeUpgrader(allowedOrigin string) websocket.Upgrader {
	return websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			if origin == "" {
				return true
			}
			if allowedOrigin != "" {
				return origin == allowedOrigin
			}
			return origin == "http://"+r.Host || origin == "https://"+r.Host
		},
	}
}

// --- Response helpers ---

func respond(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "data": data})
}

func ok(w http.ResponseWriter, data interface{}) {
	respond(w, http.StatusOK, data)
}

func created(w http.ResponseWriter, data interface{}) {
	respond(w, http.StatusCreated, data)
}

// APIError is the structured error envelope returned by all API endpoints.
type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func httpStatusToCode(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "BAD_REQUEST"
	case http.StatusUnauthorized:
		return "UNAUTHORIZED"
	case http.StatusForbidden:
		return "FORBIDDEN"
	case http.StatusNotFound:
		return "NOT_FOUND"
	case http.StatusConflict:
		return "CONFLICT"
	case http.StatusServiceUnavailable:
		return "SERVICE_UNAVAILABLE"
	}
	return "INTERNAL_ERROR"
}

func errResp(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":    false,
		"error": APIError{Code: httpStatusToCode(status), Message: msg},
	})
}

func parsePagination(r *http.Request) (before string, limit int) {
	before = r.URL.Query().Get("before")
	limit = 50
	if l, _ := strconv.Atoi(r.URL.Query().Get("limit")); l > 0 && l <= 100 {
		limit = l
	}
	return
}

func (h *Handler) currentUser(r *http.Request) (*db.User, error) {
	claims := mw.GetClaims(r)
	if claims == nil {
		return nil, nil
	}
	return h.db.GetUserByID(claims.UserID)
}

func (h *Handler) requireAdmin(w http.ResponseWriter, r *http.Request) (*db.User, bool) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return nil, false
	}
	if !u.IsOwner && !h.db.HasPermission(u, db.PermAdministrator) {
		errResp(w, http.StatusForbidden, "insufficient permissions")
		return nil, false
	}
	return u, true
}

// --- WebSocket handler ---

func (h *Handler) WebSocket(w http.ResponseWriter, r *http.Request) {
	claims := mw.GetClaims(r)
	if claims == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	// Validate single-use CSRF token passed as ?csrf=<token>.
	csrfToken := r.URL.Query().Get("csrf")
	if csrfToken == "" {
		http.Error(w, "missing csrf token", http.StatusForbidden)
		return
	}
	ownerID := h.db.ConsumeCSRFToken(csrfToken)
	if ownerID == "" || ownerID != claims.UserID {
		http.Error(w, "invalid or expired csrf token", http.StatusForbidden)
		return
	}

	upgrader := makeUpgrader(h.allowedOrigin)
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	client := h.hub.NewClient(conn, claims.UserID)
	h.hub.Register(client)

	go client.WritePump()
	go client.ReadPump(h.handleWSMessage)
}

// IssueCSRFToken issues a short-lived single-use CSRF token for the current user.
// The client must pass this as ?csrf=<token> on the WebSocket URL.
func (h *Handler) IssueCSRFToken(w http.ResponseWriter, r *http.Request) {
	claims := mw.GetClaims(r)
	if claims == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	token, err := h.db.IssueCSRFToken(claims.UserID)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to issue token")
		return
	}
	ok(w, map[string]string{"token": token})
}

// VoiceRooms returns a snapshot of who is currently in each voice room.
func (h *Handler) VoiceRooms(w http.ResponseWriter, r *http.Request) {
	snapshot := h.hub.GetVoiceRoomSnapshot()
	ok(w, map[string]interface{}{"rooms": snapshot})
}
