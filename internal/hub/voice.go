package hub

// BroadcastToVoiceRoom sends an event to all clients in a voice room, optionally excluding one.
func (h *Hub) BroadcastToVoiceRoom(channelID string, event WSEvent, exclude *Client) {
	h.voiceRoomsMu.RLock()
	defer h.voiceRoomsMu.RUnlock()
	room, ok := h.voiceRooms[channelID]
	if !ok {
		return
	}
	for client := range room {
		if client == exclude {
			continue
		}
		client.SendEvent(event)
	}
}

// JoinVoiceRoom adds a client to a voice room and returns existing participant user IDs.
func (h *Hub) JoinVoiceRoom(channelID string, client *Client) []string {
	h.voiceRoomsMu.Lock()
	defer h.voiceRoomsMu.Unlock()
	if h.voiceRooms[channelID] == nil {
		h.voiceRooms[channelID] = make(map[*Client]bool)
	}
	existing := make([]string, 0)
	for c := range h.voiceRooms[channelID] {
		existing = append(existing, c.UserID)
	}
	h.voiceRooms[channelID][client] = true
	return existing
}

// LeaveVoiceRoom removes a client from a specific voice room. Returns true if the client was present.
func (h *Hub) LeaveVoiceRoom(channelID string, client *Client) bool {
	h.voiceRoomsMu.Lock()
	defer h.voiceRoomsMu.Unlock()
	room, ok := h.voiceRooms[channelID]
	if !ok {
		return false
	}
	if _, in := room[client]; !in {
		return false
	}
	delete(room, client)
	if len(room) == 0 {
		delete(h.voiceRooms, channelID)
	}
	return true
}

// leaveAllVoiceRooms removes a client from every voice room (called on disconnect).
func (h *Hub) leaveAllVoiceRooms(client *Client) {
	h.voiceRoomsMu.Lock()
	var affected []string
	for channelID, room := range h.voiceRooms {
		if _, in := room[client]; in {
			delete(room, client)
			affected = append(affected, channelID)
			if len(room) == 0 {
				delete(h.voiceRooms, channelID)
			}
		}
	}
	h.voiceRoomsMu.Unlock()

	for _, channelID := range affected {
		evt := WSEvent{
			Type: "voice.left",
			Data: map[string]string{
				"channel_id": channelID,
				"user_id":    client.UserID,
			},
		}
		h.BroadcastToVoiceRoom(channelID, evt, nil)
		h.Broadcast(evt)
	}
}

// AreInSameVoiceRoom returns true if both userIDs have active clients in channelID.
func (h *Hub) AreInSameVoiceRoom(channelID, userA, userB string) bool {
	h.voiceRoomsMu.RLock()
	defer h.voiceRoomsMu.RUnlock()
	room, ok := h.voiceRooms[channelID]
	if !ok {
		return false
	}
	var foundA, foundB bool
	for c := range room {
		if c.UserID == userA {
			foundA = true
		}
		if c.UserID == userB {
			foundB = true
		}
	}
	return foundA && foundB
}

// GetVoiceRoomSnapshot returns a map of channelID → []userID for all active rooms.
func (h *Hub) GetVoiceRoomSnapshot() map[string][]string {
	h.voiceRoomsMu.RLock()
	defer h.voiceRoomsMu.RUnlock()
	out := make(map[string][]string)
	for channelID, room := range h.voiceRooms {
		uids := make([]string, 0, len(room))
		for c := range room {
			uids = append(uids, c.UserID)
		}
		out[channelID] = uids
	}
	return out
}
