package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"chirm/internal/db"
	"chirm/internal/events"
	mw "chirm/internal/middleware"
)

func (h *Handler) GetMessages(w http.ResponseWriter, r *http.Request) {
	channelID := chi.URLParam(r, "id")
	before := r.URL.Query().Get("before")
	limit := 50
	if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 && l <= 100 {
		limit = l
	}

	if _, err := h.db.GetChannelByID(channelID); err != nil {
		errResp(w, http.StatusNotFound, "channel not found")
		return
	}

	msgs, err := h.db.GetMessages(channelID, before, limit+1)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to get messages")
		return
	}
	if msgs == nil {
		msgs = []db.Message{}
	}
	hasMore := len(msgs) > limit
	if hasMore {
		msgs = msgs[:limit]
	}
	ok(w, map[string]interface{}{"messages": msgs, "has_more": hasMore})
}

func (h *Handler) SendMessage(w http.ResponseWriter, r *http.Request) {
	// Determine identity: user or bot
	u, _ := h.currentUser(r)
	botClaims := mw.GetBotClaims(r)

	if u == nil && botClaims == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	// Check PermSendMessages
	if u != nil && !h.db.HasPermission(u, db.PermSendMessages) {
		errResp(w, http.StatusForbidden, "no permission to send messages")
		return
	}
	if botClaims != nil && botClaims.Permissions&db.PermSendMessages == 0 {
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
		Attachments []string `json:"attachments"`
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

	var msg *db.Message
	var err error
	var authorID, authorName string

	if u != nil {
		msg, err = h.db.CreateMessage(channelID, u.ID, req.Content, req.ReplyToID)
		authorID = u.ID
		if msg != nil && msg.Author != nil {
			authorName = msg.Author.Username
		} else {
			authorName = "Someone"
		}
	} else {
		msg, err = h.db.CreateMessageFromBot(channelID, botClaims.BotID, req.Content, req.ReplyToID)
		authorID = "bot:" + botClaims.BotID
		authorName = botClaims.BotName
	}
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to send message")
		return
	}

	for _, attID := range req.Attachments {
		if attID != "" {
			h.db.LinkAttachment(attID, msg.ID)
		}
	}
	if len(req.Attachments) > 0 {
		if full, err := h.db.GetMessageByID(msg.ID); err == nil {
			msg = full
		}
	}

	chObj, _ := h.db.GetChannelByID(channelID)
	chName := channelID
	if chObj != nil {
		chName = chObj.Name
	}
	contentPreview := msg.Content
	if len(contentPreview) > 120 {
		contentPreview = contentPreview[:120] + "…"
	}

	h.bus.Publish(events.Event{
		Type: events.MessageCreated,
		Data: events.MessageCreatedData{
			Message:        msg,
			ChannelID:      channelID,
			ChannelName:    chName,
			AuthorID:       authorID,
			AuthorName:     authorName,
			ContentPreview: contentPreview,
		},
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
	h.bus.Publish(events.Event{
		Type: events.ReactionUpdated,
		Data: events.ReactionUpdatedData{
			MessageID: msgID,
			ChannelID: msg.ChannelID,
			Reactions: reactions,
		},
	})
	ok(w, map[string]interface{}{
		"message_id": msgID,
		"channel_id": msg.ChannelID,
		"reactions":  reactions,
	})
}

func (h *Handler) RemoveReaction(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	msgID := chi.URLParam(r, "id")
	var req struct {
		Emoji string `json:"emoji"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Emoji == "" {
		errResp(w, http.StatusBadRequest, "emoji required")
		return
	}
	emoji := req.Emoji

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
	h.bus.Publish(events.Event{
		Type: events.ReactionUpdated,
		Data: events.ReactionUpdatedData{
			MessageID: msgID,
			ChannelID: msg.ChannelID,
			Reactions: reactions,
		},
	})
	ok(w, map[string]interface{}{
		"message_id": msgID,
		"channel_id": msg.ChannelID,
		"reactions":  reactions,
	})
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
	h.bus.Publish(events.Event{
		Type: events.MessageEdited,
		Data: events.MessageEditedData{
			Message:   updated,
			ChannelID: msg.ChannelID,
		},
	})
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

	h.bus.Publish(events.Event{
		Type: events.MessageDeleted,
		Data: events.MessageDeletedData{
			MessageID: id,
			ChannelID: channelID,
		},
	})
	ok(w, map[string]string{"message": "deleted"})
}
