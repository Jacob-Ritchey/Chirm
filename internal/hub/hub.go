package hub

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/gorilla/websocket"
)

// WSEvent is the envelope for all WebSocket messages.
type WSEvent struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

// RawClientMessage is an incoming WebSocket message before dispatch.
type RawClientMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// Client represents a single WebSocket connection.
type Client struct {
	Hub       *Hub
	conn      *websocket.Conn
	Send      chan []byte
	UserID    string
	channelID string
	mu        sync.Mutex
}

// Hub manages all active WebSocket clients and voice room state.
type Hub struct {
	clients    map[*Client]bool
	broadcast  chan []byte
	register   chan *Client
	unregister chan *Client
	mu         sync.RWMutex

	voiceRooms   map[string]map[*Client]bool
	voiceRoomsMu sync.RWMutex

	allowedOrigin string
}

// New creates a new Hub.
func New(allowedOrigin string) *Hub {
	return &Hub{
		clients:       make(map[*Client]bool),
		broadcast:     make(chan []byte, 256),
		register:      make(chan *Client),
		unregister:    make(chan *Client),
		voiceRooms:    make(map[string]map[*Client]bool),
		allowedOrigin: allowedOrigin,
	}
}

// AllowedOrigin returns the configured allowed WebSocket origin.
func (h *Hub) AllowedOrigin() string {
	return h.allowedOrigin
}

// NewClient creates a new Client attached to this hub.
func (h *Hub) NewClient(conn *websocket.Conn, userID string) *Client {
	return &Client{
		Hub:    h,
		conn:   conn,
		Send:   make(chan []byte, 256),
		UserID: userID,
	}
}

// Register adds a client to the hub.
func (h *Hub) Register(c *Client) {
	h.register <- c
}

// Run is the hub's main event loop. Call it in a goroutine.
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
				close(client.Send)
			}
			h.mu.Unlock()
			h.leaveAllVoiceRooms(client)

		case message := <-h.broadcast:
			h.mu.RLock()
			var dead []*Client
			for client := range h.clients {
				select {
				case client.Send <- message:
				default:
					dead = append(dead, client)
				}
			}
			h.mu.RUnlock()
			if len(dead) > 0 {
				h.mu.Lock()
				for _, client := range dead {
					if _, ok := h.clients[client]; ok {
						close(client.Send)
						delete(h.clients, client)
					}
				}
				h.mu.Unlock()
			}
		}
	}
}

// Broadcast sends an event to all connected clients.
func (h *Hub) Broadcast(event WSEvent) {
	data, err := json.Marshal(event)
	if err != nil {
		log.Println("ws marshal error:", err)
		return
	}
	h.broadcast <- data
}

// BroadcastToChannel sends an event only to clients viewing a specific channel.
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
			case client.Send <- data:
			default:
			}
		}
	}
}

// SendToUser sends an event to a specific user by userID.
func (h *Hub) SendToUser(targetUserID string, event WSEvent) {
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for client := range h.clients {
		if client.UserID == targetUserID {
			select {
			case client.Send <- data:
			default:
			}
		}
	}
}

// SetChannel updates which channel this client is currently viewing.
func (c *Client) SetChannel(channelID string) {
	c.mu.Lock()
	c.channelID = channelID
	c.mu.Unlock()
}

// WritePump drains the client's send channel to the WebSocket connection.
func (c *Client) WritePump() {
	defer c.conn.Close()
	for msg := range c.Send {
		if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			break
		}
	}
}

// ReadPump reads messages from the WebSocket and dispatches them via the provided function.
func (c *Client) ReadPump(dispatch func(*Client, RawClientMessage)) {
	defer func() {
		c.Hub.unregister <- c
		c.conn.Close()
	}()
	c.conn.SetReadLimit(64 * 1024)
	for {
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			break
		}
		var evt RawClientMessage
		if err := json.Unmarshal(msg, &evt); err != nil {
			continue
		}
		dispatch(c, evt)
	}
}

// SendEvent marshals an event and enqueues it for this client.
// The recover guards against a send on a closed channel if the hub has already
// marked this client as dead and closed its Send channel.
func (c *Client) SendEvent(event WSEvent) {
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	defer func() { recover() }()
	select {
	case c.Send <- data:
	default:
	}
}
