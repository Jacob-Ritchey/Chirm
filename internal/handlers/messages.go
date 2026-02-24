package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"chirm/internal/db"
)

func (h *Handler) GetMessages(w http.ResponseWriter, r *http.Request) {
	channelID := chi.URLParam(r, "id")
	before := r.URL.Query().Get("before")
	limit := 50
	if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 && l <= 100 {
		limit = l
	}

	// Verify channel exists
	if _, err := h.db.GetChannelByID(channelID); err != nil {
		errResp(w, http.StatusNotFound, "channel not found")
		return
	}

	msgs, err := h.db.GetMessages(channelID, before, limit)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to get messages")
		return
	}
	if msgs == nil {
		msgs = []db.Message{}
	}
	ok(w, msgs)
}

func (h *Handler) SendMessage(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	if !h.db.HasPermission(u, db.PermSendMessages) {
		errResp(w, http.StatusForbidden, "no permission to send messages")
		return
	}

	channelID := chi.URLParam(r, "id")
	if _, err := h.db.GetChannelByID(channelID); err != nil {
		errResp(w, http.StatusNotFound, "channel not found")
		return
	}

	var req struct {
		Content     string   `json:"content"`
		Attachments []string `json:"attachments"` // attachment IDs
		ReplyToID   *string  `json:"reply_to_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}

	req.Content = strings.TrimSpace(req.Content)
	if req.Content == "" && len(req.Attachments) == 0 {
		errResp(w, http.StatusBadRequest, "message cannot be empty")
		return
	}
	if len(req.Content) > 4000 {
		errResp(w, http.StatusBadRequest, "message too long")
		return
	}

	msg, err := h.db.CreateMessage(channelID, u.ID, req.Content, req.ReplyToID)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to send message")
		return
	}

	// Link any pre-uploaded attachments to this message
	for _, attID := range req.Attachments {
		if attID != "" {
			h.db.LinkAttachment(attID, msg.ID)
		}
	}

	// Re-fetch so the response includes attachment data
	if len(req.Attachments) > 0 {
		if full, err := h.db.GetMessageByID(msg.ID); err == nil {
			msg = full
		}
	}

	// Broadcast to all channel subscribers (message.new is channel-scoped)
	h.hub.BroadcastToChannel(channelID, WSEvent{Type: "message.new", Data: msg})

	// Resolve channel name and author for notifications
	chObj, _ := h.db.GetChannelByID(channelID)
	chName := channelID
	if chObj != nil {
		chName = chObj.Name
	}
	contentPreview := msg.Content
	if len(contentPreview) > 120 {
		contentPreview = contentPreview[:120] + "…"
	}
	authorName := "Someone"
	if msg.Author != nil {
		authorName = msg.Author.Username
	}
	authorID := msg.UserID

	// Broadcast globally so ALL clients can update unread dots AND show in-app
	// notifications — message.new only reaches the subscribed channel's clients.
	h.hub.Broadcast(WSEvent{Type: "message.activity", Data: map[string]interface{}{
		"channel_id":   channelID,
		"channel_name": chName,
		"author_id":    authorID,
		"author":       authorName,
		"preview":      contentPreview,
		"message_id":   msg.ID,
	}})

	// Send Web Push notifications (background, non-blocking)
	h.BroadcastPush(chName, u.ID, PushPayload{
		Title:     authorName + " in #" + chName,
		Body:      contentPreview,
		ChannelID: channelID,
		MessageID: msg.ID,
		Tag:       "chirm-" + channelID,
	})

	created(w, msg)
}

func (h *Handler) AddReaction(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	msgID := chi.URLParam(r, "id")
	msg, err := h.db.GetMessageByID(msgID)
	if err != nil {
		errResp(w, http.StatusNotFound, "message not found")
		return
	}

	var req struct {
		Emoji string `json:"emoji"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Emoji == "" {
		errResp(w, http.StatusBadRequest, "emoji required")
		return
	}

	if err := h.db.AddReaction(msgID, u.ID, req.Emoji); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to add reaction")
		return
	}

	reactions, _ := h.db.GetReactions(msgID)
	payload := map[string]interface{}{
		"message_id": msgID,
		"channel_id": msg.ChannelID,
		"reactions":  reactions,
	}
	h.hub.BroadcastToChannel(msg.ChannelID, WSEvent{Type: "reaction.update", Data: payload})
	ok(w, payload)
}

func (h *Handler) RemoveReaction(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	msgID := chi.URLParam(r, "id")
	emoji := chi.URLParam(r, "emoji")

	msg, err := h.db.GetMessageByID(msgID)
	if err != nil {
		errResp(w, http.StatusNotFound, "message not found")
		return
	}

	if err := h.db.RemoveReaction(msgID, u.ID, emoji); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to remove reaction")
		return
	}

	reactions, _ := h.db.GetReactions(msgID)
	payload := map[string]interface{}{
		"message_id": msgID,
		"channel_id": msg.ChannelID,
		"reactions":  reactions,
	}
	h.hub.BroadcastToChannel(msg.ChannelID, WSEvent{Type: "reaction.update", Data: payload})
	ok(w, payload)
}

func (h *Handler) EditMessage(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	id := chi.URLParam(r, "id")
	msg, err := h.db.GetMessageByID(id)
	if err != nil {
		errResp(w, http.StatusNotFound, "message not found")
		return
	}

	// Author or admin can edit
	if msg.UserID != u.ID && !h.db.HasPermission(u, db.PermManageMessages) {
		errResp(w, http.StatusForbidden, "cannot edit this message")
		return
	}

	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}

	req.Content = strings.TrimSpace(req.Content)
	if req.Content == "" {
		errResp(w, http.StatusBadRequest, "content cannot be empty")
		return
	}

	if err := h.db.EditMessage(id, req.Content); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to edit message")
		return
	}

	updated, _ := h.db.GetMessageByID(id)
	h.hub.BroadcastToChannel(msg.ChannelID, WSEvent{Type: "message.edit", Data: updated})
	ok(w, updated)
}

func (h *Handler) DeleteMessage(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	id := chi.URLParam(r, "id")
	msg, err := h.db.GetMessageByID(id)
	if err != nil {
		errResp(w, http.StatusNotFound, "message not found")
		return
	}

	if msg.UserID != u.ID && !h.db.HasPermission(u, db.PermManageMessages) {
		errResp(w, http.StatusForbidden, "cannot delete this message")
		return
	}

	channelID := msg.ChannelID
	if err := h.db.DeleteMessage(id); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to delete message")
		return
	}

	h.hub.BroadcastToChannel(channelID, WSEvent{Type: "message.delete", Data: map[string]string{"id": id, "channel_id": channelID}})
	ok(w, map[string]string{"message": "deleted"})
}
