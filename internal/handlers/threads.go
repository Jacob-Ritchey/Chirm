package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"chirm/internal/db"
	"chirm/internal/events"
)

func (h *Handler) ListThreads(w http.ResponseWriter, r *http.Request) {
	channelID := chi.URLParam(r, "id")
	if _, err := h.store.GetChannelByID(channelID); err != nil {
		errResp(w, http.StatusForbidden, "channel not found")
		return
	}

	// Page-based path (for forum/gallery channel views).
	if pageStr := r.URL.Query().Get("page"); pageStr != "" {
		page, _ := strconv.Atoi(pageStr)
		if page < 1 {
			page = 1
		}
		perPage := 20
		if pp, _ := strconv.Atoi(r.URL.Query().Get("per_page")); pp > 0 && pp <= 100 {
			perPage = pp
		}
		total, err := h.store.CountThreadsByChannel(channelID)
		if err != nil {
			errResp(w, http.StatusInternalServerError, "failed to count threads")
			return
		}
		totalPages := (total + perPage - 1) / perPage
		if totalPages == 0 {
			totalPages = 1
		}
		if page > totalPages {
			page = totalPages
		}
		threads, err := h.store.ListThreadsByChannelPaged(channelID, page, perPage)
		if err != nil {
			errResp(w, http.StatusInternalServerError, "failed to list threads")
			return
		}
		if threads == nil {
			threads = []db.Thread{}
		}
		ok(w, map[string]interface{}{
			"threads":     threads,
			"total":       total,
			"page":        page,
			"per_page":    perPage,
			"total_pages": totalPages,
		})
		return
	}

	// Cursor-based path (for text channel thread panels — unchanged).
	before, limit := parsePagination(r)
	threads, err := h.store.ListThreadsByChannel(channelID, before, limit+1)
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
	if !h.store.HasPermission(u, db.PermSendMessages) {
		errResp(w, http.StatusForbidden, "no permission to create threads")
		return
	}

	channelID := chi.URLParam(r, "id")
	if _, err := h.store.GetChannelByID(channelID); err != nil {
		errResp(w, http.StatusForbidden, "channel not found")
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

	// Validate source message belongs to this channel.
	if req.SourceMessageID != nil {
		srcMsg, err := h.store.GetMessageByID(*req.SourceMessageID)
		if err != nil || srcMsg.ChannelID != channelID {
			errResp(w, http.StatusBadRequest, "source message not found in channel")
			return
		}
	}

	thread, err := h.store.CreateThread(channelID, req.Name, u.ID, req.SourceMessageID)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to create thread")
		return
	}

	// Create the post body as the first message in the thread's own channel.
	content := strings.TrimSpace(req.InitialMessage)
	if content != "" || len(req.Attachments) > 0 {
		// thread.ID === thread.ThreadChannelID in the new architecture.
		msg, msgErr := h.store.CreateMessage(thread.ID, u.ID, content, nil)
		if msgErr == nil {
			for _, attID := range req.Attachments {
				if attID != "" {
					h.store.LinkAttachment(attID, msg.ID, thread.ID)
				}
			}
			h.store.IncrementThreadMessageCount(thread.ID, channelID)
			thread, _ = h.store.GetThreadByID(thread.ID)
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
	thread, err := h.store.GetThreadByID(threadID)
	if err != nil {
		errResp(w, http.StatusNotFound, "thread not found")
		return
	}

	if thread.CreatorID != u.ID && !h.store.HasPermission(u, db.PermManageMessages) {
		errResp(w, http.StatusForbidden, "cannot delete this thread")
		return
	}

	channelID := thread.ChannelID
	if err := h.store.DeleteThread(threadID); err != nil {
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
func (h *Handler) GetThreadFirstMessage(w http.ResponseWriter, r *http.Request) {
	threadID := chi.URLParam(r, "id")
	msg, err := h.store.GetThreadFirstMessage(threadID)
	if err != nil {
		ok(w, map[string]interface{}{"message": nil})
		return
	}
	ok(w, map[string]interface{}{"message": msg})
}

func (h *Handler) GetThreadMessages(w http.ResponseWriter, r *http.Request) {
	threadID := chi.URLParam(r, "id")
	// Validate thread exists.
	if _, err := h.store.GetThreadByID(threadID); err != nil {
		errResp(w, http.StatusNotFound, "thread not found")
		return
	}

	before, limit := parsePagination(r)
	// thread_id === thread_channel_id — messages live in channels/{threadID}.db
	msgs, err := h.store.GetMessages(threadID, before, limit+1)
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
	if !h.store.HasPermission(u, db.PermSendMessages) {
		errResp(w, http.StatusForbidden, "no permission to send messages")
		return
	}

	threadID := chi.URLParam(r, "id")
	thread, err := h.store.GetThreadByID(threadID)
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

	// thread.ID === thread.ThreadChannelID — store message in thread's own channel DB.
	msg, err := h.store.CreateMessage(thread.ID, u.ID, req.Content, req.ReplyToID)
	if err != nil {
		errResp(w, http.StatusInternalServerError, "failed to send message")
		return
	}

	for _, attID := range req.Attachments {
		if attID != "" {
			h.store.LinkAttachment(attID, msg.ID, thread.ID)
		}
	}
	if len(req.Attachments) > 0 {
		if full, err := h.store.GetMessageByID(msg.ID); err == nil {
			msg = full
		}
	}

	authorName := msg.AuthorUsername
	if authorName == "" {
		authorName = "Someone"
	}
	contentPreview := msg.Content
	if len(contentPreview) > 120 {
		contentPreview = contentPreview[:120] + "…"
	}

	// Update thread message counts.
	h.store.IncrementThreadMessageCount(thread.ID, thread.ChannelID)

	// Broadcast message.new to thread channel subscribers.
	h.bus.Publish(events.Event{
		Type: events.MessageCreated,
		Data: events.MessageCreatedData{
			Message:        msg,
			ChannelID:      thread.ID,
			ChannelName:    thread.Name,
			AuthorID:       u.ID,
			AuthorName:     authorName,
			ContentPreview: contentPreview,
		},
	})

	// Also fire thread.message.new so parent-channel subscribers update reply counts.
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
