package handlers

import (
	"encoding/json"

	"chirm/internal/hub"
)

// handleWSMessage dispatches incoming WebSocket messages from a client.
// This is the transport layer: it decodes the message type and calls the
// appropriate Hub method or sends responses back to the client.
func (h *Handler) handleWSMessage(c *hub.Client, evt hub.RawClientMessage) {
	switch evt.Type {

	case "subscribe":
		var d struct {
			ChannelID string `json:"channel_id"`
		}
		if json.Unmarshal(evt.Data, &d) == nil {
			c.SetChannel(d.ChannelID)
		}

	case "typing":
		var d struct {
			ChannelID string `json:"channel_id"`
		}
		if json.Unmarshal(evt.Data, &d) == nil {
			h.hub.BroadcastToChannel(d.ChannelID, hub.WSEvent{
				Type: "typing",
				Data: map[string]string{
					"user_id":    c.UserID,
					"channel_id": d.ChannelID,
				},
			})
		}

	case "voice.join":
		var d struct {
			ChannelID string `json:"channel_id"`
		}
		if json.Unmarshal(evt.Data, &d) != nil || d.ChannelID == "" {
			return
		}
		// Verify the channel exists before admitting the client.
		if ch, err := h.db.GetChannelByID(d.ChannelID); err != nil || ch == nil {
			return
		}
		existing := h.hub.JoinVoiceRoom(d.ChannelID, c)

		c.SendEvent(hub.WSEvent{
			Type: "voice.room_state",
			Data: map[string]interface{}{
				"channel_id":   d.ChannelID,
				"participants": existing,
			},
		})

		h.hub.BroadcastToVoiceRoom(d.ChannelID, hub.WSEvent{
			Type: "voice.joined",
			Data: map[string]string{
				"channel_id": d.ChannelID,
				"user_id":    c.UserID,
			},
		}, c)

		h.hub.Broadcast(hub.WSEvent{
			Type: "voice.joined",
			Data: map[string]string{
				"channel_id": d.ChannelID,
				"user_id":    c.UserID,
			},
		})

	case "voice.leave":
		var d struct {
			ChannelID string `json:"channel_id"`
		}
		if json.Unmarshal(evt.Data, &d) != nil || d.ChannelID == "" {
			return
		}
		if h.hub.LeaveVoiceRoom(d.ChannelID, c) {
			leaveEvt := hub.WSEvent{
				Type: "voice.left",
				Data: map[string]string{
					"channel_id": d.ChannelID,
					"user_id":    c.UserID,
				},
			}
			h.hub.BroadcastToVoiceRoom(d.ChannelID, leaveEvt, nil)
			h.hub.Broadcast(leaveEvt)
		}

	case "voice.offer", "voice.answer", "voice.ice":
		var d struct {
			ChannelID    string          `json:"channel_id"`
			TargetUserID string          `json:"target_user_id"`
			Payload      json.RawMessage `json:"payload"`
		}
		if json.Unmarshal(evt.Data, &d) != nil || d.TargetUserID == "" {
			return
		}
		if !h.hub.AreInSameVoiceRoom(d.ChannelID, c.UserID, d.TargetUserID) {
			return
		}
		h.hub.SendToUser(d.TargetUserID, hub.WSEvent{
			Type: evt.Type,
			Data: map[string]interface{}{
				"channel_id":   d.ChannelID,
				"from_user_id": c.UserID,
				"payload":      d.Payload,
			},
		})

	case "voice.media_state":
		var d struct {
			ChannelID     string `json:"channel_id"`
			CamEnabled    bool   `json:"cam_enabled"`
			ScreenSharing bool   `json:"screen_sharing"`
		}
		if json.Unmarshal(evt.Data, &d) != nil || d.ChannelID == "" {
			return
		}
		h.hub.BroadcastToVoiceRoom(d.ChannelID, hub.WSEvent{
			Type: "voice.media_state",
			Data: map[string]interface{}{
				"channel_id":     d.ChannelID,
				"from_user_id":   c.UserID,
				"cam_enabled":    d.CamEnabled,
				"screen_sharing": d.ScreenSharing,
			},
		}, c)
	}
}
