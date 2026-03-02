package events

import (
	"log"
	"sync"
)

// Handler is a function that receives an event.
type Handler func(Event)

// Bus is an in-process publish/subscribe event bus.
// Subscribers receive events asynchronously in separate goroutines.
type Bus struct {
	mu       sync.RWMutex
	handlers map[EventType][]Handler
}

// New creates a new Bus.
func New() *Bus {
	return &Bus{handlers: make(map[EventType][]Handler)}
}

// Subscribe registers a handler for the given event type.
func (b *Bus) Subscribe(t EventType, h Handler) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.handlers[t] = append(b.handlers[t], h)
}

// Publish dispatches an event to all registered handlers asynchronously.
// Each handler runs in its own goroutine; the publisher is never blocked.
func (b *Bus) Publish(e Event) {
	b.mu.RLock()
	handlers := make([]Handler, len(b.handlers[e.Type]))
	copy(handlers, b.handlers[e.Type])
	b.mu.RUnlock()
	for _, h := range handlers {
		h := h
		go func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("events: handler for %s panicked: %v", e.Type, r)
				}
			}()
			h(e)
		}()
	}
}
