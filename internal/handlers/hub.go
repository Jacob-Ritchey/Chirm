package handlers

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/gorilla/websocket"
)

// WSEvent is the envelope for all WebSocket messages
type WSEvent struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

// Client represents a single WebSocket connection
type Client struct {
	hub       *Hub
	conn      *websocket.Conn
	send      chan []byte
	userID    string
	channelID string // currently viewed text channel
	mu        sync.Mutex
}

// Hub manages all active WebSocket clients
type Hub struct {
	clients    map[*Client]bool
	broadcast  chan []byte
	register   chan *Client
	unregister chan *Client
	mu         sync.RWMutex

	// voiceRooms: channelID → set of clients currently in that voice room
	voiceRooms    map[string]map[*Client]bool
	voiceRoomsMu  sync.RWMutex

	allowedOrigin string // used by WS upgrader origin check
}

func NewHub(allowedOrigin string) *Hub {
	return &Hub{
		clients:       make(map[*Client]bool),
		broadcast:     make(chan []byte, 256),
		register:      make(chan *Client),
		unregister:    make(chan *Client),
		voiceRooms:    make(map[string]map[*Client]bool),
		allowedOrigin: allowedOrigin,
	}
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			h.mu.Unlock()

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
			}
			h.mu.Unlock()
			h.leaveAllVoiceRooms(client)

		case message := <-h.broadcast:
			// Fix #6: collect dead clients under RLock, then evict under write lock
			// to avoid a map-write-while-read-locked data race.
			h.mu.RLock()
			var dead []*Client
			for client := range h.clients {
				select {
				case client.send <- message:
				default:
					dead = append(dead, client)
				}
			}
			h.mu.RUnlock()
			if len(dead) > 0 {
				h.mu.Lock()
				for _, client := range dead {
					if _, ok := h.clients[client]; ok {
						close(client.send)
						delete(h.clients, client)
					}
				}
				h.mu.Unlock()
			}
		}
	}
}

// Broadcast sends an event to all connected clients
func (h *Hub) Broadcast(event WSEvent) {
	data, err := json.Marshal(event)
	if err != nil {
		log.Println("ws marshal error:", err)
		return
	}
	h.broadcast <- data
}

// BroadcastToChannel sends an event only to clients viewing a specific channel
func (h *Hub) BroadcastToChannel(channelID string, event WSEvent) {
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for client := range h.clients {
		client.mu.Lock()
		inChannel := client.channelID == channelID
		client.mu.Unlock()
		if inChannel {
			select {
			case client.send <- data:
			default:
			}
		}
	}
}

// SendToUser sends an event to a specific user by userID
func (h *Hub) SendToUser(targetUserID string, event WSEvent) {
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for client := range h.clients {
		if client.userID == targetUserID {
			select {
			case client.send <- data:
			default:
			}
		}
	}
}

// BroadcastToVoiceRoom sends an event to all clients in a voice room, optionally excluding one
func (h *Hub) BroadcastToVoiceRoom(channelID string, event WSEvent, exclude *Client) {
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
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
		select {
		case client.send <- data:
		default:
		}
	}
}

// joinVoiceRoom adds a client to a voice room and returns existing participant user IDs
func (h *Hub) joinVoiceRoom(channelID string, client *Client) []string {
	h.voiceRoomsMu.Lock()
	defer h.voiceRoomsMu.Unlock()
	if h.voiceRooms[channelID] == nil {
		h.voiceRooms[channelID] = make(map[*Client]bool)
	}
	existing := make([]string, 0)
	for c := range h.voiceRooms[channelID] {
		existing = append(existing, c.userID)
	}
	h.voiceRooms[channelID][client] = true
	return existing
}

// leaveVoiceRoom removes a client from a specific voice room
func (h *Hub) leaveVoiceRoom(channelID string, client *Client) bool {
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

// leaveAllVoiceRooms removes a client from every voice room (used on disconnect)
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
				"user_id":    client.userID,
			},
		}
		h.BroadcastToVoiceRoom(channelID, evt, nil)
		h.Broadcast(evt)
	}
}

// AreInSameVoiceRoom returns true if both userIDs have active clients in channelID.
// Fix #13: Used to gate WebRTC signaling relay.
func (h *Hub) AreInSameVoiceRoom(channelID, userA, userB string) bool {
	h.voiceRoomsMu.RLock()
	defer h.voiceRoomsMu.RUnlock()
	room, ok := h.voiceRooms[channelID]
	if !ok {
		return false
	}
	var foundA, foundB bool
	for c := range room {
		if c.userID == userA {
			foundA = true
		}
		if c.userID == userB {
			foundB = true
		}
	}
	return foundA && foundB
}

// GetVoiceRoomSnapshot returns a map of channelID → []userID for all active rooms
func (h *Hub) GetVoiceRoomSnapshot() map[string][]string {
	h.voiceRoomsMu.RLock()
	defer h.voiceRoomsMu.RUnlock()
	out := make(map[string][]string)
	for channelID, room := range h.voiceRooms {
		uids := make([]string, 0, len(room))
		for c := range room {
			uids = append(uids, c.userID)
		}
		out[channelID] = uids
	}
	return out
}

func (c *Client) SetChannel(channelID string) {
	c.mu.Lock()
	c.channelID = channelID
	c.mu.Unlock()
}

func (c *Client) writePump() {
	defer c.conn.Close()
	for msg := range c.send {
		if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			break
		}
	}
}

type rawClientMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()
	// Fix #7: Limit incoming message size to prevent memory-exhaustion DoS.
	c.conn.SetReadLimit(64 * 1024) // 64 KB per message
	for {
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			break
		}
		var evt rawClientMessage
		if err := json.Unmarshal(msg, &evt); err != nil {
			continue
		}
		c.handleMessage(evt)
	}
}

func (c *Client) handleMessage(evt rawClientMessage) {
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
			c.hub.BroadcastToChannel(d.ChannelID, WSEvent{
				Type: "typing",
				Data: map[string]string{
					"user_id":    c.userID,
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
		existing := c.hub.joinVoiceRoom(d.ChannelID, c)

		// Tell joiner who's already present
		c.sendEvent(WSEvent{
			Type: "voice.room_state",
			Data: map[string]interface{}{
				"channel_id":   d.ChannelID,
				"participants": existing,
			},
		})

		// Notify others in the room
		c.hub.BroadcastToVoiceRoom(d.ChannelID, WSEvent{
			Type: "voice.joined",
			Data: map[string]string{
				"channel_id": d.ChannelID,
				"user_id":    c.userID,
			},
		}, c)

		// Broadcast to whole server for sidebar participant count
		c.hub.Broadcast(WSEvent{
			Type: "voice.joined",
			Data: map[string]string{
				"channel_id": d.ChannelID,
				"user_id":    c.userID,
			},
		})

	case "voice.leave":
		var d struct {
			ChannelID string `json:"channel_id"`
		}
		if json.Unmarshal(evt.Data, &d) != nil || d.ChannelID == "" {
			return
		}
		if c.hub.leaveVoiceRoom(d.ChannelID, c) {
			evt := WSEvent{
				Type: "voice.left",
				Data: map[string]string{
					"channel_id": d.ChannelID,
					"user_id":    c.userID,
				},
			}
			c.hub.BroadcastToVoiceRoom(d.ChannelID, evt, nil)
			c.hub.Broadcast(evt)
		}

	// WebRTC signaling relay — server routes to the target peer only if
	// Fix #13: both sender and target are verified members of the same voice room.
	case "voice.offer", "voice.answer", "voice.ice":
		var d struct {
			ChannelID    string          `json:"channel_id"`
			TargetUserID string          `json:"target_user_id"`
			Payload      json.RawMessage `json:"payload"`
		}
		if json.Unmarshal(evt.Data, &d) != nil || d.TargetUserID == "" {
			return
		}
		// Verify both parties are in the same voice room before relaying.
		if !c.hub.AreInSameVoiceRoom(d.ChannelID, c.userID, d.TargetUserID) {
			return
		}
		c.hub.SendToUser(d.TargetUserID, WSEvent{
			Type: evt.Type,
			Data: map[string]interface{}{
				"channel_id":   d.ChannelID,
				"from_user_id": c.userID,
				"payload":      d.Payload,
			},
		})

	// Broadcast camera/mic state to everyone else in the room so they can
	// show/hide the video tile vs avatar without relying on track detection.
	case "voice.media_state":
		var d struct {
			ChannelID      string `json:"channel_id"`
			CamEnabled     bool   `json:"cam_enabled"`
			ScreenSharing  bool   `json:"screen_sharing"`
		}
		if json.Unmarshal(evt.Data, &d) != nil || d.ChannelID == "" {
			return
		}
		c.hub.BroadcastToVoiceRoom(d.ChannelID, WSEvent{
			Type: "voice.media_state",
			Data: map[string]interface{}{
				"channel_id":     d.ChannelID,
				"from_user_id":   c.userID,
				"cam_enabled":    d.CamEnabled,
				"screen_sharing": d.ScreenSharing,
			},
		}, c)
	}
}

func (c *Client) sendEvent(event WSEvent) {
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	select {
	case c.send <- data:
	default:
	}
}
