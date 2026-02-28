package plugin

import (
	"github.com/go-chi/chi/v5"

	"chirm/internal/db"
	"chirm/internal/events"
	"chirm/internal/hub"
)

// PluginHub is the sandboxed broadcast interface exposed to plugins.
type PluginHub interface {
	Broadcast(event hub.WSEvent)
	BroadcastToChannel(channelID string, event hub.WSEvent)
	SendToUser(targetUserID string, event hub.WSEvent)
}

// PluginDB is the sandboxed database interface exposed to plugins.
type PluginDB interface {
	GetUserByID(id string) (*db.User, error)
	GetChannelByID(id string) (*db.Channel, error)
	ListChannels() ([]db.Channel, error)
	GetMessages(channelID, before string, limit int) ([]db.Message, error)
	ListUsers() ([]db.User, error)
}

// PluginContext is passed to Plugin.Init and gives a plugin its sandboxed resources.
type PluginContext struct {
	Bus    *events.Bus
	Hub    PluginHub
	DB     PluginDB
	Router chi.Router // mounted at /api/v1/plugins/{name}/
}

// Plugin is the interface that all Chirm plugins must implement.
type Plugin interface {
	// Name returns a unique, URL-safe identifier for the plugin.
	Name() string

	// Init is called once at startup. The plugin registers event subscriptions
	// and HTTP handlers using the provided PluginContext.
	Init(ctx PluginContext) error

	// Shutdown is called when the server is stopping. Plugins should release
	// any resources they hold.
	Shutdown() error
}

// Compile-time interface satisfaction assertions.
// These will fail to compile if hub.Hub or db.DB drift away from the plugin interfaces.
var _ PluginHub = (*hub.Hub)(nil)
var _ PluginDB = (*db.DB)(nil)
