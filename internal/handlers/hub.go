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
	channelID string // currently viewed channel
	mu        sync.Mutex
}

// Hub manages all active WebSocket clients
type Hub struct {
	clients    map[*Client]bool
	broadcast  chan []byte
	register   chan *Client
	unregister chan *Client
	mu         sync.RWMutex
}

func NewHub() *Hub {
	return &Hub{
		clients:    make(map[*Client]bool),
		broadcast:  make(chan []byte, 256),
		register:   make(chan *Client),
		unregister: make(chan *Client),
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

		case message := <-h.broadcast:
			h.mu.RLock()
			for client := range h.clients {
				select {
				case client.send <- message:
				default:
					// Client too slow, disconnect
					close(client.send)
					delete(h.clients, client)
				}
			}
			h.mu.RUnlock()
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

func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()
	for {
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			break
		}
		// Handle client→server messages (e.g. channel subscribe, typing)
		var evt struct {
			Type string `json:"type"`
			Data struct {
				ChannelID string `json:"channel_id"`
			} `json:"data"`
		}
		if json.Unmarshal(msg, &evt) == nil {
			switch evt.Type {
			case "subscribe":
				c.SetChannel(evt.Data.ChannelID)
			case "typing":
				c.hub.BroadcastToChannel(evt.Data.ChannelID, WSEvent{
					Type: "typing",
					Data: map[string]string{
						"user_id":    c.userID,
						"channel_id": evt.Data.ChannelID,
					},
				})
			}
		}
	}
}
