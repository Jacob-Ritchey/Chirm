# Chirm — Architecture Refactoring Plan

**Goal:** Restructure the codebase to support plugin, API, bot, and theme extensibility for v1.0, without abandoning the minimal-dependency philosophy.

---

## Current Pain Points (What Drives This)

| Area | Problem | Impact |
|---|---|---|
| `db.go` (1,040 lines) | All models, migrations, and queries in one file | Hard to navigate, no domain boundaries |
| `app.js` (3,004 lines) | Monolithic frontend with no module system | Bottleneck for contributors, can't isolate features |
| Handler ↔ Hub coupling | Handlers directly call `hub.Broadcast()` | Adding plugins/bots means touching every handler |
| No migration versioning | `CREATE IF NOT EXISTS` + bare `ALTER TABLE` | Risky upgrades, no rollback, no schema history |
| Config scattered | `os.Getenv` / `getEnv` calls spread across files | No validation, no typed defaults, hard to document |
| No API versioning | Endpoints live at `/api/` flat | Can't evolve the API without breaking existing clients |
| Error format inconsistent | Some handlers return `{"error":"..."}`, others use `http.Error` | Bots/clients can't reliably parse errors |

---

## Proposed Directory Structure

```
chirm/
├── main.go                         # Slim — config load, wire deps, start server
├── internal/
│   ├── config/
│   │   └── config.go               # Typed config struct, env + YAML loading
│   ├── auth/
│   │   └── auth.go                 # (unchanged — already clean)
│   ├── db/
│   │   ├── db.go                   # Init, connection, migration runner
│   │   ├── migrate.go              # Migration engine + schema_version tracking
│   │   ├── models.go               # All struct types (User, Channel, Message, etc.)
│   │   ├── users.go                # User CRUD + permission computation
│   │   ├── channels.go             # Channel + Category CRUD
│   │   ├── messages.go             # Message CRUD, attachments, reactions
│   │   ├── roles.go                # Role CRUD + assignment
│   │   ├── invites.go              # Invite CRUD + validation
│   │   ├── settings.go             # Server settings KV
│   │   ├── emojis.go               # Custom emoji CRUD
│   │   └── push.go                 # Push subscription storage
│   ├── events/
│   │   ├── bus.go                   # In-process event bus (publish/subscribe)
│   │   └── types.go                 # Event type constants + payload structs
│   ├── hub/
│   │   ├── hub.go                   # Hub + Client + Run loop (extracted from handlers)
│   │   └── voice.go                 # Voice room state management
│   ├── handlers/
│   │   ├── handler.go               # Handler struct, helpers, response utilities
│   │   ├── auth.go                  # Login/register/logout/me
│   │   ├── channels.go              # Channel + category endpoints
│   │   ├── messages.go              # Message CRUD endpoints
│   │   ├── users.go                 # User/role/invite management
│   │   ├── uploads.go               # File upload + serving
│   │   ├── emojis.go                # Custom emoji endpoints
│   │   ├── push.go                  # VAPID + push subscription endpoints
│   │   ├── setup.go                 # First-run setup
│   │   ├── linkpreview.go           # Link preview fetcher
│   │   └── ws.go                    # WebSocket upgrade + message dispatch
│   ├── middleware/
│   │   ├── auth.go                  # JWT cookie middleware (existing)
│   │   └── ratelimit.go             # IP rate limiter (extracted from main.go)
│   ├── plugin/                      # NEW — plugin interface stubs
│   │   └── plugin.go                # Plugin interface definition
│   └── router/
│       └── router.go                # Route registration, API versioning
├── migrations/
│   ├── 001_initial.sql
│   ├── 002_add_replies.sql
│   ├── 003_add_channel_emoji.sql
│   └── 004_add_channel_categories.sql
├── static/
│   ├── js/
│   │   ├── app.js                   # Bootstrap + init (slim)
│   │   ├── api.js                   # HTTP client module
│   │   ├── state.js                 # App state + reactive proxy
│   │   ├── ws.js                    # WebSocket (existing, minor changes)
│   │   ├── render/
│   │   │   ├── sidebar.js           # Channel list, server header, categories
│   │   │   ├── messages.js          # Message list, compose, replies
│   │   │   ├── members.js           # Members panel
│   │   │   ├── admin.js             # Admin panel tabs
│   │   │   ├── modals.js            # Modal helpers, channel/role/profile editors
│   │   │   └── media.js             # Image viewer, file upload preview, link previews
│   │   ├── voice.js                 # (existing — already separate)
│   │   ├── cache.js                 # (existing — already separate)
│   │   ├── mentions.js              # (existing)
│   │   ├── notifications.js         # (existing)
│   │   ├── user-settings.js         # (existing)
│   │   └── emoji-data.js            # (existing)
│   ├── css/
│   │   └── app.css                  # (keep single file, formalize CSS variables)
│   └── ...
└── docs/
    └── adr/                         # Architecture Decision Records
```

---

## Backend Refactoring — Step by Step

### 1. Extract Configuration (`internal/config/`)

**Why first:** Every other refactoring step benefits from a single source of truth for config.

```go
// internal/config/config.go
package config

type Config struct {
    Port          string `env:"PORT"           default:"8080"`
    HTTPSPort     string `env:"HTTPS_PORT"     default:"8443"`
    DataDir       string `env:"DATA_DIR"       default:"./data"`
    JWTSecret     string `env:"JWT_SECRET"     required:"true"`
    AllowedOrigin string `env:"ALLOWED_ORIGIN" default:""`
    TLSCert       string `env:"CHIRM_TLS_CERT" default:""`
    TLSKey        string `env:"CHIRM_TLS_KEY"  default:""`
    MaxUploadSize int64  `env:"MAX_UPLOAD_MB"  default:"50"`
}

func Load() (*Config, error) {
    // 1. Load .env file (reuse existing loadDotenv logic)
    // 2. Read env vars into struct
    // 3. Validate required fields
    // 4. Return typed config
}
```

**Migration path:** Replace every `getEnv()` and `os.Getenv()` call in `main.go` and handlers with `cfg.FieldName`. Pass `*Config` into `handlers.New()`.

### 2. Split `db.go` into Domain Files

This is the highest-value backend change. The current file has 6 distinct domains mixed together.

**Target split:**

| New File | Lines (approx) | Contents moved from `db.go` |
|---|---|---|
| `db.go` | ~50 | `DB` struct, `Init()`, `NewID()` |
| `migrate.go` | ~80 | New migration runner (see below) |
| `models.go` | ~90 | All struct types (`User`, `Channel`, `Message`, etc.) |
| `users.go` | ~100 | `CreateUser`, `GetUserBy*`, `ListUsers`, `UpdateUser`, `DeleteUser`, `UserCount`, `ComputePermissions`, `HasPermission` |
| `channels.go` | ~120 | Channel + Category CRUD, reorder |
| `messages.go` | ~150 | Message CRUD, attachments, reactions |
| `roles.go` | ~80 | Role CRUD, `GetUserRoles`, `AssignRole`, `RemoveRole`, `GetEveryoneRole` |
| `invites.go` | ~80 | Invite CRUD, `IsInviteValid`, `CleanOrphanedAttachments` |
| `settings.go` | ~40 | `IsSetupDone`, `GetSetting`, `SetSetting`, `GetAllSettings` |
| `emojis.go` | ~70 | Custom emoji CRUD |
| `push.go` | ~50 | Push subscription storage |

**Key principle:** The `DB` struct and `NewID()` stay in `db.go`. Everything else moves to its domain file. All files remain in the `db` package — this is an organizational split, not a package boundary change. No import paths change.

**Safe migration approach:**
1. Create each new file with the functions cut from `db.go`
2. Leave `db.go` with just `DB`, `Init()`, `NewID()`, and the permission constants
3. Run `go build` — if it compiles, you're done (same package = no import changes needed)

### 3. Versioned Migrations

Replace the current inline DDL approach with numbered migration files.

```go
// internal/db/migrate.go
package db

import (
    "embed"
    "fmt"
    "sort"
    "strings"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

func (d *DB) migrate() error {
    // Create tracking table
    d.Exec(`CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`)

    // Get current version
    var current int
    d.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_version`).Scan(&current)

    // Read and sort migration files
    entries, _ := migrationFS.ReadDir("migrations")
    sort.Slice(entries, func(i, j int) bool {
        return entries[i].Name() < entries[j].Name()
    })

    // Apply pending migrations
    for _, entry := range entries {
        version := parseVersion(entry.Name()) // "001_initial.sql" → 1
        if version <= current {
            continue
        }
        sql, _ := migrationFS.ReadFile("migrations/" + entry.Name())
        if _, err := d.Exec(string(sql)); err != nil {
            return fmt.Errorf("migration %s failed: %w", entry.Name(), err)
        }
        d.Exec(`INSERT INTO schema_version (version) VALUES (?)`, version)
    }
    return nil
}
```

**Converting the current schema:** Take the existing `CREATE TABLE` block and the `ALTER TABLE` additions, and split them into separate numbered files:

- `001_initial.sql` — The base schema (all 10 `CREATE TABLE` statements + indexes)
- `002_add_replies.sql` — `ALTER TABLE messages ADD COLUMN reply_to_id TEXT`
- `003_add_channel_emoji.sql` — `ALTER TABLE channels ADD COLUMN emoji TEXT DEFAULT ''`
- `004_add_channel_categories.sql` — `ALTER TABLE channels ADD COLUMN category_id TEXT DEFAULT ''`

Existing databases: The migration runner detects they already have the tables via `schema_version`. On first run against an old database, seed `schema_version` with version 4 (since all existing ALTER TABLEs are already applied via the current idempotent approach). Add a one-time bootstrap check for this.

### 4. Extract the Hub into Its Own Package (`internal/hub/`)

The Hub is currently in `handlers/` but it's not a handler — it's infrastructure. Extracting it clarifies the dependency graph: handlers *use* the hub, they don't *contain* it.

**What moves:**
- `hub.go` → `internal/hub/hub.go` (Hub, Client, Run, Broadcast*, voice room methods)
- Voice room management can go in `hub/voice.go` for clarity

**What changes:**
- `handlers.Handler` gets `hub *hub.Hub` instead of `hub *Hub`
- `handlers.go` WebSocket handler creates `hub.Client` instead of `Client`
- The `readPump` → `handleMessage` dispatch stays with the WS handler (it calls handler-layer logic), but uses exported Hub methods

**Important:** The `Client.handleMessage` switch statement mixes transport concerns (WS message dispatch) with business logic (voice room management, WebRTC relay). During extraction, move the WS message dispatch into a new `handlers/ws.go` that receives parsed events and calls Hub methods. This is the natural seam for the future bot framework — bots will also need to call these same Hub methods but through the REST/WS bot gateway instead.

### 5. Introduce an Event Bus (`internal/events/`)

This is the key architectural enabler for plugins and bots. Currently, when a message is sent, `messages.go` directly calls `h.hub.Broadcast()` and `h.BroadcastPush()`. With an event bus, handlers publish events and the hub, push notifications, and future plugins all subscribe independently.

```go
// internal/events/types.go
package events

type EventType string

const (
    MessageCreated  EventType = "message.created"
    MessageEdited   EventType = "message.edited"
    MessageDeleted  EventType = "message.deleted"
    UserJoined      EventType = "user.joined"
    UserLeft        EventType = "user.left"
    ChannelCreated  EventType = "channel.created"
    ChannelDeleted  EventType = "channel.deleted"
    ReactionAdded   EventType = "reaction.added"
    ReactionRemoved EventType = "reaction.removed"
)

type Event struct {
    Type EventType
    Data interface{}
}

// Typed payload structs
type MessageCreatedData struct {
    Message   *db.Message
    ChannelID string
}
// ... etc.
```

```go
// internal/events/bus.go
package events

import "sync"

type Handler func(Event)

type Bus struct {
    mu       sync.RWMutex
    handlers map[EventType][]Handler
}

func New() *Bus {
    return &Bus{handlers: make(map[EventType][]Handler)}
}

func (b *Bus) Subscribe(t EventType, h Handler) {
    b.mu.Lock()
    defer b.mu.Unlock()
    b.handlers[t] = append(b.handlers[t], h)
}

func (b *Bus) Publish(e Event) {
    b.mu.RLock()
    handlers := b.handlers[e.Type]
    b.mu.RUnlock()
    for _, h := range handlers {
        go h(e) // async dispatch — subscribers don't block the publisher
    }
}
```

**Wiring in `main.go`:**
```go
bus := events.New()

// Hub subscribes to broadcast WS events
bus.Subscribe(events.MessageCreated, func(e events.Event) {
    d := e.Data.(events.MessageCreatedData)
    hub.Broadcast(hub.WSEvent{Type: "message", Data: d.Message})
})

// Push notifications subscribe independently
bus.Subscribe(events.MessageCreated, func(e events.Event) {
    d := e.Data.(events.MessageCreatedData)
    h.BroadcastPush(d.ChannelID, d.Message.UserID, ...)
})
```

**Migration path:** Do this incrementally. Start with `MessageCreated` — change `handlers/messages.go` `SendMessage` to publish an event instead of calling `hub.Broadcast` directly. Verify it works, then convert remaining event types one by one.

### 6. Plugin Interface Stubs (`internal/plugin/`)

Don't build the full plugin system yet — just define the interface so the event bus and handler structure are designed to accommodate it.

```go
// internal/plugin/plugin.go
package plugin

import "chirm/internal/events"

// Plugin defines the contract for Chirm plugins.
// Phase 2 ships this interface; Phase 4/5 implement loading.
type Plugin interface {
    // Name returns the plugin's unique identifier
    Name() string

    // Init is called once at startup with the event bus for subscriptions
    Init(bus *events.Bus) error

    // Shutdown is called on server stop for cleanup
    Shutdown() error
}
```

This costs almost nothing to add but documents intent and validates that the event bus design actually works for the plugin use case.

### 7. API Versioning & Error Standardization

**Versioned routes:** In `router/router.go`, mount everything under `/api/v1/`:

```go
r.Route("/api/v1", func(r chi.Router) {
    // All current /api/ routes move here
})
// Backward compat: redirect /api/* → /api/v1/*
r.Handle("/api/*", http.RedirectHandler("/api/v1/", http.StatusTemporaryRedirect))
```

**Standardized errors:** Replace the current `errResp` with a structured error type:

```go
type APIError struct {
    Code    string `json:"code"`    // machine-readable: "INVALID_INVITE", "FORBIDDEN"
    Message string `json:"message"` // human-readable
}

func errResp(w http.ResponseWriter, status int, code, msg string) {
    respond(w, status, map[string]interface{}{
        "error": APIError{Code: code, Message: msg},
    })
}
```

Then update all handler call sites. This is tedious but mechanical — a good grep-and-replace task.

### 8. Rate Limiter Extraction + Memory Leak Fix

Move the `ipRateLimiter` from `main.go` to `internal/middleware/ratelimit.go` and add the cleanup goroutine the roadmap calls for:

```go
func (rl *ipRateLimiter) cleanup(maxAge time.Duration) {
    ticker := time.NewTicker(10 * time.Minute)
    for range ticker.C {
        rl.mu.Lock()
        // Evict entries not seen in maxAge
        // (requires adding a lastSeen timestamp to each entry)
        rl.mu.Unlock()
    }
}
```

---

## Frontend Refactoring — Step by Step

### 1. Convert to ES Modules (Zero Build Tools)

This is the single highest-impact frontend change. The key insight: native `<script type="module">` with `import/export` requires zero build tools and works in all modern browsers.

**In `index.html`, replace:**
```html
<script src="/js/app.js"></script>
```
**With:**
```html
<script type="module" src="/js/app.js"></script>
```

**Then decompose `app.js` into modules.** The import graph looks like:

```
app.js (boot + init)
├── api.js (HTTP client)
├── state.js (App object + reactive proxy)
├── ws.js (WebSocket — already separate, add export)
├── render/
│   ├── sidebar.js (renderServerHeader, renderChannelList, toggleCategory, drag-and-drop)
│   ├── messages.js (renderMessages, renderMessage, sendMessage, editMessage, reactions)
│   ├── members.js (renderMembersList, renderUserPanel)
│   ├── admin.js (openAdmin, all admin* functions)
│   ├── modals.js (openModal, closeModal, showSimpleModal, profile, channel/role editors)
│   └── media.js (openImageViewer, handleFileUpload, link previews, emoji picker)
├── voice.js (already separate)
├── cache.js (already separate)
├── mentions.js (already separate)
├── notifications.js (already separate)
└── user-settings.js (already separate)
```

### 2. Extract State Management (`state.js`)

Wrap the global `App` object in a module with controlled access:

```javascript
// state.js
const state = {
  user: null,
  channels: [],
  categories: [],
  currentChannel: null,
  messages: {},
  members: [],
  roles: [],
  unread: new Set(),
  typingUsers: {},
  voiceParticipants: {},
  replyTo: null,
  collapsedCategories: new Set(),
  customEmojis: [],
};

export default state;

// Helper for persistence
export function persistUnread() { ... }
export function saveLastChannel(channelId) { ... }
export function loadLastChannel() { ... }
```

Every other module imports `state` from `state.js` instead of reaching for a global. This is the foundation for the Proxy-based reactivity the roadmap mentions — you can add it later inside `state.js` without touching any consumers.

### 3. Extract the API Client (`api.js`)

```javascript
// api.js
const api = {
  async fetch(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || data.error || `HTTP ${res.status}`);
    return data;
  },
  get: (p) => api.fetch(p),
  post: (p, body) => api.fetch(p, { method: 'POST', body: JSON.stringify(body) }),
  put: (p, body) => api.fetch(p, { method: 'PUT', body: JSON.stringify(body) }),
  del: (p) => api.fetch(p, { method: 'DELETE' }),
};

export default api;
```

Note: When API versioning is added on the backend, update the base path here once: `const BASE = '/api/v1'`.

### 4. Split Render Functions by Domain

This is the bulk of the work. Group the ~80 functions in `app.js` by what part of the UI they touch:

**`render/sidebar.js`** (~300 lines): `renderServerHeader`, `toggleServerInfo`, `openServerRules`, `renderChannelList`, `toggleCategory`, `toggleChannelEditMode`, all drag-and-drop functions, `openCreateChannel`, `openEditChannel`, `confirmDeleteChannel`, `openCreateCategory`, `openEditCategory`, `confirmDeleteCategory`.

**`render/messages.js`** (~400 lines): `renderMessages`, `renderMessage`, `renderContent`, `renderReactions`, `updateReactionsInDOM`, `sendMessage`, `editMessage`, `deleteMessage`, `setReply`, `clearReply`, `toggleReaction`, `scrollToBottom`, `isNearBottom`, `loadMoreMessages`, `scrollToMessage`, `onInputKeydown`, `resizeInput`, `updateTypingIndicator`.

**`render/members.js`** (~80 lines): `renderMembersList`, `renderUserPanel`.

**`render/admin.js`** (~400 lines): `openAdmin`, `loadAdminUsers`, `renderAdminUsers`, `renderAdminRoles`, `renderAdminInvites`, `renderAdminSettings`, `renderAdminEmojis`, all admin action functions, `switchAdminTab`, `saveSettings`, upload functions.

**`render/modals.js`** (~200 lines): `openModal`, `closeModal`, `showSimpleModal`, `openProfile`, `clearAvatar`, role/invite creation modals, `openAssignRole`.

**`render/media.js`** (~300 lines): `openImageViewer`, `handleFileUpload`, `showUploadPreview`, `clearUploadPreview`, `buildEmojiPicker`, `openEmojiPicker`, `openInputEmojiPicker`, `selectEmoji`, `closeEmojiPicker`, `insertEmoji`, `fetchLinkPreview`, `scheduleLinePreviews`, `buildPreviewCard`.

**Shared utilities** stay in `app.js` (now slim): `toast`, `avatar`, `stringToColor`, `esc`, `formatTime`, `formatSize`, `isAdmin`. Or extract a `utils.js` if you prefer.

### 5. Formalize CSS Variable Contract

The CSS already uses custom properties. Formalize them as the theming API:

```css
/* Top of app.css — the Theme Contract */
:root {
  /* === BACKGROUND === */
  --bg-primary: #1a1a2e;
  --bg-secondary: #16213e;
  --bg-tertiary: #0f3460;
  --bg-input: #16213e;
  --bg-hover: rgba(255,255,255,0.05);

  /* === TEXT === */
  --text-primary: #e0e0e0;
  --text-secondary: #a0a0a0;
  --text-muted: #666;

  /* === ACCENT === */
  --accent: #6c63ff;
  --accent-hover: #5a52d5;
  --danger: #e05252;
  --success: #3fba7a;
  --warning: #e0a030;

  /* === BORDERS & RADII === */
  --border-color: rgba(255,255,255,0.08);
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 16px;

  /* === TYPOGRAPHY === */
  --font-size-base: 14px;
  --font-family: 'Inter', sans-serif;
}
```

Document each variable. The Phase 3 theming engine just swaps these values via JSON → CSS variable injection.

---

## Recommended Execution Order

The refactoring should be done in this sequence to minimize risk. Each step should be a separate branch/PR that gets merged before starting the next.

| Step | Task | Risk | Dependencies |
|---|---|---|---|
| 1 | Extract config (`internal/config/`) | Low | None |
| 2 | Split `db.go` into domain files | Low | None (same package) |
| 3 | Add versioned migrations | Medium | Step 2 |
| 4 | Extract rate limiter to middleware | Low | Step 1 |
| 5 | Extract Hub into `internal/hub/` | Medium | None |
| 6 | Add event bus (`internal/events/`) | Medium | Step 5 |
| 7 | Wire first event (MessageCreated) through bus | Medium | Step 6 |
| 8 | Convert remaining events to bus | Low (per-event) | Step 7 |
| 9 | Standardize API error responses | Low | None |
| 10 | Add API versioning (`/api/v1/`) | Low | Step 9 |
| 11 | Add plugin interface stubs | Low | Step 6 |
| 12 | Frontend: convert to ES modules | Medium | None |
| 13 | Frontend: extract state.js + api.js | Low | Step 12 |
| 14 | Frontend: split render modules | Medium | Step 13 |
| 15 | Frontend: formalize CSS variable contract | Low | None |

Steps 1–4 and 12–15 can be done in parallel (backend and frontend are independent). Steps 5–8 are the core architectural change and should be done carefully with testing.

---

## What NOT to Refactor Yet

Some things from the roadmap are better left for later phases:

- **Proxy-based reactive state** (roadmap Phase 2) — do the module split first, add reactivity later inside `state.js`. Doing both at once is too risky.
- **Template literal components** — good idea but can wait until the module split is stable. The current string-based HTML works fine for now.
- **Plugin loading/registration** — define the interface now (step 11), implement actual plugin loading in Phase 4/5.
- **WebSocket protocol versioning** — add when there's actually a second version to negotiate. Right now it adds complexity for no benefit.
- **CSRF protection, authenticated uploads, CSP** — these are Phase 1 (security hardening) items. Don't mix security fixes with architecture refactoring; they deserve their own focused attention.

---

## Testing Strategy for the Refactor

Since there are no existing tests (the roadmap calls this out), each refactoring step should include at minimum:

- **Manual smoke test:** Start the server, create a user, send messages, try voice chat. This catches obvious regressions.
- **`go vet` + `go build`** on every commit. Add a pre-commit hook or CI check.
- **Compilation is your safety net** for same-package splits (steps 2, 4). If it compiles, you haven't broken imports.
- **For the event bus (steps 6–8):** Write a simple test that publishes `MessageCreated` and verifies subscribers receive it. This is the one place a unit test pays for itself immediately.

The full testing foundation (unit tests, handler tests, CI pipeline) called for in the roadmap's Phase 1 is ideally done before this refactoring, but if you're doing them in parallel, at minimum cover `auth` and `db` packages first.
