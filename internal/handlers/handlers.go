package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/gorilla/websocket"

	"nexus/internal/auth"
	"nexus/internal/db"
	mw "nexus/internal/middleware"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

type Handler struct {
	db      *db.DB
	auth    *auth.Service
	hub     *Hub
	dataDir string
}

func New(database *db.DB, authSvc *auth.Service, hub *Hub, dataDir string) *Handler {
	return &Handler{db: database, auth: authSvc, hub: hub, dataDir: dataDir}
}

// --- Response helpers ---

func respond(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func ok(w http.ResponseWriter, data interface{}) {
	respond(w, http.StatusOK, data)
}

func created(w http.ResponseWriter, data interface{}) {
	respond(w, http.StatusCreated, data)
}

func errResp(w http.ResponseWriter, status int, msg string) {
	respond(w, status, map[string]string{"error": msg})
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
	if !h.db.HasPermission(u, db.PermManageServer) {
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

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	client := &Client{
		hub:    h.hub,
		conn:   conn,
		send:   make(chan []byte, 256),
		userID: claims.UserID,
	}
	h.hub.register <- client

	go client.writePump()
	go client.readPump()
}

// VoiceRooms returns a snapshot of who is currently in each voice room.
// Used by clients on page load to populate sidebar participant lists.
func (h *Handler) VoiceRooms(w http.ResponseWriter, r *http.Request) {
	snapshot := h.hub.GetVoiceRoomSnapshot()
	ok(w, map[string]interface{}{"rooms": snapshot})
}
