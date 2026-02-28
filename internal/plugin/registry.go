package plugin

import "sync"

// Registry holds all registered plugins and provides thread-safe access.
type Registry struct {
	mu      sync.RWMutex
	plugins []Plugin
}

func NewRegistry() *Registry {
	return &Registry{}
}

func (r *Registry) Register(p Plugin) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.plugins = append(r.plugins, p)
}

func (r *Registry) All() []Plugin {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Plugin, len(r.plugins))
	copy(out, r.plugins)
	return out
}
