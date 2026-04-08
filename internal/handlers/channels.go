package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"chirm/internal/db"
	"chirm/internal/events"
	"chirm/internal/hub"
)

func (h *Handler) ListChannels(w http.ResponseWriter, r *http.Request) {
	before, limit := parsePagination(r)
	items, err := h.store.ListChannelsPaginated(before, limit+1)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to list channels")
		return
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	if items == nil {
		items = []db.Channel{}
	}
	ok(w, map[string]interface{}{"items": items, "has_more": hasMore})
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
		Emoji       string `json:"emoji"`
		CategoryID  string `json:"category_id"`
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

	channel, err := h.store.CreateChannel(req.Name, req.Description, req.Type, req.Emoji, req.CategoryID)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to create channel")
		return
	}

	h.bus.Publish(events.Event{Type: events.ChannelCreated, Data: events.ChannelCreatedData{Channel: channel}})
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
		Emoji       string `json:"emoji"`
		CategoryID  string `json:"category_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}

	if err := h.store.UpdateChannel(id, req.Name, req.Description, req.Emoji, req.CategoryID); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to update channel")
		return
	}

	channel, _ := h.store.GetChannelByID(id)
	h.hub.Broadcast(hub.WSEvent{Type: "channel.update", Data: channel})
	ok(w, channel)
}

func (h *Handler) DeleteChannel(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}

	id := chi.URLParam(r, "id")
	if err := h.store.DeleteChannel(id); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to delete channel")
		return
	}

	h.bus.Publish(events.Event{Type: events.ChannelDeleted, Data: events.ChannelDeletedData{ChannelID: id}})
	ok(w, map[string]string{"message": "deleted"})
}

// ReorderChannels handles bulk position/category updates for drag-and-drop.
func (h *Handler) ReorderChannels(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}

	var req []struct {
		ID         string `json:"id"`
		Position   int    `json:"position"`
		CategoryID string `json:"category_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}

	orders := make([]struct {
		ID         string
		Position   int
		CategoryID string
	}, len(req))
	for i, r := range req {
		orders[i] = struct {
			ID         string
			Position   int
			CategoryID string
		}{r.ID, r.Position, r.CategoryID}
	}

	if err := h.store.ReorderChannels(orders); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to reorder channels")
		return
	}

	channels, _ := h.store.ListChannels()
	h.hub.Broadcast(hub.WSEvent{Type: "channels.reorder", Data: channels})
	ok(w, map[string]string{"message": "reordered"})
}

// ─── Channel Categories ────────────────────────────────────────────────────────

func (h *Handler) ListCategories(w http.ResponseWriter, r *http.Request) {
	cats, err := h.store.ListCategories()
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to list categories")
		return
	}
	ok(w, cats)
}

func (h *Handler) CreateCategory(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}

	var req struct {
		Name string `json:"name"`
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

	cat, err := h.store.CreateCategory(req.Name)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to create category")
		return
	}

	h.hub.Broadcast(hub.WSEvent{Type: "category.new", Data: cat})
	created(w, cat)
}

func (h *Handler) UpdateCategory(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}

	id := chi.URLParam(r, "id")
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}

	if err := h.store.UpdateCategory(id, req.Name); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to update category")
		return
	}

	cats, _ := h.store.ListCategories()
	h.hub.Broadcast(hub.WSEvent{Type: "categories.update", Data: cats})
	ok(w, map[string]string{"message": "updated"})
}

func (h *Handler) ReorderCategories(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}

	var orders []struct {
		ID       string `json:"id"`
		Position int    `json:"position"`
	}
	if err := json.NewDecoder(r.Body).Decode(&orders); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}

	mapped := make([]struct{ ID string; Position int }, len(orders))
	for i, o := range orders {
		mapped[i].ID = o.ID
		mapped[i].Position = o.Position
	}
	if err := h.store.ReorderCategories(mapped); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to reorder categories")
		return
	}

	cats, _ := h.store.ListCategories()
	h.hub.Broadcast(hub.WSEvent{Type: "categories.update", Data: cats})
	ok(w, map[string]string{"message": "reordered"})
}

func (h *Handler) DeleteCategory(w http.ResponseWriter, r *http.Request) {
	_, isAdmin := h.requireAdmin(w, r)
	if !isAdmin {
		return
	}

	id := chi.URLParam(r, "id")
	if err := h.store.DeleteCategory(id); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to delete category")
		return
	}

	channels, _ := h.store.ListChannels()
	h.hub.Broadcast(hub.WSEvent{Type: "category.delete", Data: map[string]interface{}{"id": id, "channels": channels}})
	ok(w, map[string]string{"message": "deleted"})
}
