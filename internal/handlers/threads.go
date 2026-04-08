package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"chirm/internal/db"
	"chirm/internal/events"
)

func (h *Handler) ListThreads(w http.ResponseWriter, r *http.Request) {
	channelID := chi.URLParam(r, "id")
	if _, err := h.db.GetChannelByID(channelID); err != nil {
		errResp(w, http.StatusNotFound, "channel not found")
		return
	}

	before, limit := parsePagination(r)
	threads, err := h.db.ListThreadsByChannel(channelID, before, limit+1)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to list threads")
		return
	}
	if threads == nil {
		threads = []db.Thread{}
	}
	hasMore := len(threads) > limit
	if hasMore {
		threads = threads[:limit]
	}
	ok(w, map[string]interface{}{"threads": threads, "has_more": hasMore})
}

func (h *Handler) CreateThread(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if !h.db.HasPermission(u, db.PermSendMessages) {
		errResp(w, http.StatusForbidden, "no permission to create threads")
		return
	}

	channelID := chi.URLParam(r, "id")
	if _, err := h.db.GetChannelByID(channelID); err != nil {
		errResp(w, http.StatusNotFound, "channel not found")
		return
	}

	var req struct {
		Name            string   `json:"name"`
		SourceMessageID *string  `json:"source_message_id"`
		InitialMessage  string   `json:"initial_message"`
		Attachments     []string `json:"attachments"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errResp(w, http.StatusBadRequest, "invalid request")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		errResp(w, http.StatusBadRequest, "thread name required")
		return
	}

	// Validate source message belongs to this channel
	if req.SourceMessageID != nil {
		srcMsg, err := h.db.GetMessageByID(*req.SourceMessageID)
		if err != nil || srcMsg.ChannelID != channelID {
			errResp(w, http.StatusBadRequest, "source message not found in channel")
			return
		}
	}

	thread, err := h.db.CreateThread(channelID, req.Name, u.ID, req.SourceMessageID)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to create thread")
		return
	}

	// Create the post body as the first message in the thread's own channel.
	// Must use thread.ThreadChannelID (not channelID) and CreateMessage (not CreateThreadMessage)
	// because GetMessages filters WHERE thread_id IS NULL — CreateThreadMessage sets thread_id.
	content := strings.TrimSpace(req.InitialMessage)
	if content != "" || len(req.Attachments) > 0 {
		var msg *db.Message
		var msgErr error
		if thread.ThreadChannelID != "" {
			msg, msgErr = h.db.CreateMessage(thread.ThreadChannelID, u.ID, content, nil)
			if msgErr == nil {
				h.db.IncrementThreadMessageCount(thread.ID)
			}
		} else {
			// Legacy fallback (thread_channel_id should always be set by CreateThread)
			msg, msgErr = h.db.CreateThreadMessage(thread.ID, channelID, u.ID, content, nil)
		}
		if msgErr == nil {
			for _, attID := range req.Attachments {
				if attID != "" {
					h.db.LinkAttachment(attID, msg.ID)
				}
			}
			thread, _ = h.db.GetThreadByID(thread.ID)
		}
	}

	h.bus.Publish(events.Event{
		Type: events.ThreadCreated,
		Data: events.ThreadCreatedData{
			Thread:    thread,
			ChannelID: channelID,
		},
	})

	created(w, thread)
}

func (h *Handler) DeleteThread(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	threadID := chi.URLParam(r, "id")
	thread, err := h.db.GetThreadByID(threadID)
	if err != nil {
		errResp(w, http.StatusNotFound, "thread not found")
		return
	}

	// Must be thread creator or have manage messages permission
	if thread.CreatorID != u.ID && !h.db.HasPermission(u, db.PermManageMessages) {
		errResp(w, http.StatusForbidden, "cannot delete this thread")
		return
	}

	channelID := thread.ChannelID
	if err := h.db.DeleteThread(threadID); err != nil {
		errResp(w, http.StatusInternalServerError, "failed to delete thread")
		return
	}

	h.bus.Publish(events.Event{
		Type: events.ThreadDeleted,
		Data: events.ThreadDeletedData{
			ThreadID:  threadID,
			ChannelID: channelID,
		},
	})

	ok(w, map[string]string{"message": "deleted"})
}

// GetThreadFirstMessage returns the first (oldest) message in a thread's channel.
// Used by forum/gallery preview cards so the preview never changes after replies are sent.
func (h *Handler) GetThreadFirstMessage(w http.ResponseWriter, r *http.Request) {
	threadID := chi.URLParam(r, "id")
	msg, err := h.db.GetThreadFirstMessage(threadID)
	if err != nil {
		ok(w, map[string]interface{}{"message": nil})
		return
	}
	ok(w, map[string]interface{}{"message": msg})
}

func (h *Handler) GetThreadMessages(w http.ResponseWriter, r *http.Request) {
	threadID := chi.URLParam(r, "id")
	thread, err := h.db.GetThreadByID(threadID)
	if err != nil {
		errResp(w, http.StatusNotFound, "thread not found")
		return
	}

	before, limit := parsePagination(r)

	var msgs []db.Message
	if thread.ThreadChannelID != "" {
		// New architecture: messages live in the thread's own channel.
		msgs, err = h.db.GetMessages(thread.ThreadChannelID, before, limit+1)
	} else {
		// Legacy fallback.
		msgs, err = h.db.GetThreadMessages(threadID, before, limit+1)
	}
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to get thread messages")
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

func (h *Handler) SendThreadMessage(w http.ResponseWriter, r *http.Request) {
	u, err := h.currentUser(r)
	if err != nil || u == nil {
		errResp(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if !h.db.HasPermission(u, db.PermSendMessages) {
		errResp(w, http.StatusForbidden, "no permission to send messages")
		return
	}

	threadID := chi.URLParam(r, "id")
	thread, err := h.db.GetThreadByID(threadID)
	if err != nil {
		errResp(w, http.StatusNotFound, "thread not found")
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
	if thread.ThreadChannelID != "" {
		// New architecture: store as a regular channel message in the thread's own channel.
		msg, err = h.db.CreateMessage(thread.ThreadChannelID, u.ID, req.Content, req.ReplyToID)
	} else {
		// Legacy fallback.
		msg, err = h.db.CreateThreadMessage(threadID, thread.ChannelID, u.ID, req.Content, req.ReplyToID)
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

	authorName := "Someone"
	if msg.Author != nil {
		authorName = msg.Author.Username
	}
	contentPreview := msg.Content
	if len(contentPreview) > 120 {
		contentPreview = contentPreview[:120] + "…"
	}

	if thread.ThreadChannelID != "" {
		// New architecture: fire MessageCreated so thread-channel subscribers get message.new,
		// then fire ThreadMessageCreated so parent-channel subscribers can update reply counts.
		h.db.IncrementThreadMessageCount(thread.ID)
		h.bus.Publish(events.Event{
			Type: events.MessageCreated,
			Data: events.MessageCreatedData{
				Message:        msg,
				ChannelID:      thread.ThreadChannelID,
				ChannelName:    thread.Name,
				AuthorID:       u.ID,
				AuthorName:     authorName,
				ContentPreview: contentPreview,
			},
		})
	}

	h.bus.Publish(events.Event{
		Type: events.ThreadMessageCreated,
		Data: events.ThreadMessageCreatedData{
			Message:        msg,
			ThreadID:       threadID,
			ChannelID:      thread.ChannelID,
			AuthorID:       u.ID,
			AuthorName:     authorName,
			ContentPreview: contentPreview,
		},
	})

	created(w, msg)
}
