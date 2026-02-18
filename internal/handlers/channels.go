package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"nexus/internal/db"
)

func (h *Handler) ListChannels(w http.ResponseWriter, r *http.Request) {
	channels, err := h.db.ListChannels()
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to list channels")
		return
	}
	if channels == nil {
		channels = []db.Channel{}
	}
	ok(w, channels)
}

func (h *Handler) CreateChannel(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}

	var req struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Type        string `json:"type"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}

	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		errResp(w, http.StatusBadRequest, "name required")
		return
	}
	if req.Type == "" {
		req.Type = "text"
	}

	channel, err := h.db.CreateChannel(req.Name, req.Description, req.Type)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to create channel")
		return
	}

	h.hub.Broadcast(WSEvent{Type: "channel.new", Data: channel})
	created(w, channel)
}

func (h *Handler) UpdateChannel(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}

	id := chi.URLParam(r, "id")
	var req struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}

	if err := h.db.UpdateChannel(id, req.Name, req.Description); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to update channel")
		return
	}

	channel, _ := h.db.GetChannelByID(id)
	h.hub.Broadcast(WSEvent{Type: "channel.update", Data: channel})
	ok(w, channel)
}

func (h *Handler) DeleteChannel(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}

	id := chi.URLParam(r, "id")
	if err := h.db.DeleteChannel(id); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to delete channel")
		return
	}

	h.hub.Broadcast(WSEvent{Type: "channel.delete", Data: map[string]string{"id": id}})
	ok(w, map[string]string{"message": "deleted"})
}
