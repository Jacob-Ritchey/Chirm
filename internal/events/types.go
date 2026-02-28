package events

import "chirm/internal/db"

// EventType identifies the kind of domain event.
type EventType string

const (
	MessageCreated  EventType = "message.created"
	MessageEdited   EventType = "message.edited"
	MessageDeleted  EventType = "message.deleted"
	ReactionAdded   EventType = "reaction.added"
	ReactionRemoved EventType = "reaction.removed"
	ReactionUpdated EventType = "reaction.updated"
	ChannelCreated  EventType = "channel.created"
	ChannelDeleted  EventType = "channel.deleted"
	UserJoined       EventType = "user.joined"
	UserLeft         EventType = "user.left"
	UserStatusChanged EventType = "user.status.changed"
)

// Event is the envelope passed to subscribers.
type Event struct {
	Type EventType
	Data interface{}
}

// --- Typed payload structs ---

type MessageCreatedData struct {
	Message        *db.Message
	ChannelID      string
	ChannelName    string
	AuthorID       string
	AuthorName     string
	ContentPreview string
}

type MessageEditedData struct {
	Message   *db.Message
	ChannelID string
}

type MessageDeletedData struct {
	MessageID string
	ChannelID string
}

type ReactionUpdatedData struct {
	MessageID string
	ChannelID string
	Reactions []db.Reaction
}

type ChannelCreatedData struct {
	Channel *db.Channel
}

type ChannelDeletedData struct {
	ChannelID string
}

type UserJoinedData struct {
	User *db.User
}

type UserLeftData struct {
	UserID string
}

type UserStatusChangedData struct {
	UserID string
	Status string
}
