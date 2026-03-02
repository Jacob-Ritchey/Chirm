package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"chirm/internal/db"
)

func (h *Handler) ListBots(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	bots, err := h.db.ListBots()
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to list bots")
		return
	}
	if bots == nil {
		bots = []db.Bot{}
	}
	ok(w, bots)
}

func (h *Handler) CreateBot(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	var req struct {
		Name        string `json:"name"`
		Permissions int    `json:"permissions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		errResp(w, http.StatusBadRequest, "name required")
		return
	}
	if req.Permissions == 0 {
		req.Permissions = 3 // PermReadMessages | PermSendMessages
	}
	// CreateBot returns the bot with its token (only time it is exposed)
	bot, err := h.db.CreateBot(req.Name, req.Permissions)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to create bot")
		return
	}
	created(w, bot)
}

func (h *Handler) UpdateBot(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	id := chi.URLParam(r, "id")
	var req struct {
		Name        string `json:"name"`
		Permissions int    `json:"permissions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}
	if err := h.db.UpdateBot(id, req.Name, req.Permissions); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to update bot")
		return
	}
	bot, _ := h.db.GetBotByID(id)
	ok(w, bot)
}

func (h *Handler) DeleteBot(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	id := chi.URLParam(r, "id")
	if err := h.db.DeleteBot(id); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to delete bot")
		return
	}
	ok(w, map[string]string{"message": "deleted"})
}

func (h *Handler) RegenerateBotToken(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}
	id := chi.URLParam(r, "id")
	bot, err := h.db.RegenerateBotToken(id)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to regenerate token")
		return
	}
	ok(w, bot)
}
