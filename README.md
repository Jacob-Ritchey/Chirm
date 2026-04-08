<img 
style="display: block; 
margin-left: auto;
 margin-right: auto;
 width: 30%;"
 src="https://jejunecartoons.com/wp-content/uploads/2026/02/Jenn-Circle.png" 
alt="Jenn The Wren">
</img>

# Chirm
[Chirm.org](https://chirm.org)

**Self-hosted community chat.** Real-Time Messaging with voice, video, and screen sharing for your Raspberry Pi, VPS, or home server. Single binary, SQLite databases, zero external dependencies.

> *The Wren may be small, but its song fills the forest.*

---

## Features

### Messaging

- **Real-time chat** via WebSockets with auto-reconnect
- **Multiple channels** organized into collapsible categories with drag-to-reorder
- **Threads** — create threaded discussions from any channel message; forum and gallery channel types support thread-first layouts
- **Message replies** — thread context without the complexity
- **@mention autocomplete** — type `@` to find and ping members
- **Emoji reactions** on any message
- **Custom emoji** — upload server-specific emoji for your community
- **Markdown formatting** — bold, italic, code, links
- **Link previews** — automatic OpenGraph embeds for shared URLs
- **Typing indicators** — see who's composing a message
- **Message cache** — instant channel loads from local cache, synced via WebSocket

### Voice, Video & Screen Sharing

- **Voice channels** — join a room and talk, Discord-style
- **Video calls** — toggle your camera on/off mid-call
- **Screen sharing** — share your screen with the room (V26)
- **Peer-to-peer mesh** — WebRTC direct connections, server relays signaling only
- **Opus codec tuning** — 128 kbps stereo for rich, clear audio
- **Speaking indicators** — real-time voice activity detection
- **Focus / spotlight mode** — click any tile to enlarge, or auto-follow the active speaker
- **Per-user controls** — adjust volume or mute individual participants locally

### Files & Media

- **File uploads** — images, video, audio, PDFs, text, and ZIP archives
- **Inline previews** — images, video, and audio render directly in chat
- **Configurable size limit** — set max upload size per server (default 50 MB, adjustable in admin panel)
- **Per-user storage quotas** — set a cap on how much each user can upload
- **Orphan cleanup** — background job removes uploaded files never attached to a message

### Notifications

- **Web Push notifications** — receive alerts even when the tab is closed (VAPID)
- **PWA installable** — add Chirm to your home screen on mobile or desktop
- **Per-channel muting** — silence noisy channels without leaving them
- **In-browser-only mode** — opt out of OS-level push, keep in-app toasts
- **@mention suppression** — globally disable ping notifications if you prefer

### Administration

- **First-run setup wizard** — name your server, create the owner account, get started in 60 seconds
- **Roles & permissions** — granular bitmask system (read, send, manage messages/channels/roles/server, administrator)
- **Invite system** — generate codes with optional max-use and expiry, or leave registration open
- **User management** — ban, delete, or reassign roles from the admin panel
- **Server customization** — upload a server icon and login background
- **User profiles** — avatar, banner, bio, and links for each member
- **Channel emoji** — assign an emoji icon to any channel
- **Theme customization** — create custom color themes from the admin panel
- **Bot API** — create token-scoped bots that can post messages via the REST API
- **Audit logging** — optional structured audit log with configurable per-day retention
- **TOTP / 2FA** — enable time-based one-time passwords on your account for an extra login step; backup codes included

### Security & Deployment

- **Single binary** — Go's `//go:embed` bundles all static assets, no web server required
- **SQLite + WAL** — four isolated databases (server, members, auth, per-channel), zero-setup, easy backups
- **Auto-TLS** — generates a persistent local CA and signed server certificate on first run; serves the CA at `/ca-cert` for one-click device trust
- **Custom TLS** — bring your own certs (Let's Encrypt, Tailscale, mkcert) via env vars or `certs/` directory
- **Encryption at rest** — optionally encrypt uploaded files and sensitive fields with AES-256-GCM via `CHIRM_ENCRYPTION_KEY`
- **Per-IP rate limiting** — auth endpoints are throttled to prevent brute-force
- **WebSocket message limits** — 64 KB cap prevents memory-exhaustion attacks
- **Docker ready** — multi-stage Dockerfile and compose file included
- **ARM compatible** — pure Go (no CGO), runs natively on Raspberry Pi
- **Plugin system** — sandboxed plugin interface for extending functionality
- **Healthcheck** — Docker healthcheck pings `/api/setup/status`

---

## Quick Start

**Requirements:** Go 1.22+

### Docker Setup (Recommended)

```bash
git clone https://github.com/Jacob-Ritchey/Chirm
cd Chirm
docker compose up -d
```

### Build from Source

```bash
#Clone
git clone https://github.com/Jacob-Ritchey/Chirm
cd Chirm

#Configure
cp .env.example .env
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env

#Build
go mod tidy
go build -o chirm .

# Run
./chirm
```

Open `https://localhost:8443` (accept the self-signed cert via advanced settings)

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `JWT_SECRET` | *(required)* | Secret for signing JWTs — generate with `openssl rand -hex 32` |
| `CHIRM_ENCRYPTION_KEY` | *(disabled)* | 64 hex chars (32 bytes) for optional AES-256-GCM encryption at rest — generate with `openssl rand -hex 32` |
| `PORT` | `8080` | HTTP listen port |
| `HTTPS_PORT` | `8443` | HTTPS listen port |
| `DATA_DIR` | `./data` | Directory for SQLite databases and uploads |
| `CHIRM_TLS_CERT` | *(auto)* | Path to a custom TLS certificate |
| `CHIRM_TLS_KEY` | *(auto)* | Path to a custom TLS private key |
| `ALLOWED_ORIGIN` | *(same-host)* | Full origin for WebSocket upgrades behind a reverse proxy |
| `MAX_UPLOAD_MB` | `50` | Default max file upload size (overridable per-server in settings) |
| `AUDIT_LOG_PATH` | *(disabled)* | Path to the audit log file; directory must exist |
| `LOG_RETENTION_DAYS` | `7` | Days of audit logs to keep before pruning |

All configuration is via environment variables or a `.env` file (loaded automatically, never overrides existing env vars).

---

## First Run Setup

On first visit you'll be directed to `/setup`, a wizard that:

1. Names your server
2. Creates the owner/admin account
3. Creates a `#general` channel
4. Sets up the `@everyone` role

---

## Permissions System

Permissions use a bitmask stored on roles:

| Permission | Bit | Description |
| --- | --- | --- |
| Read Messages | 1   | View channels and history |
| Send Messages | 2   | Post messages |
| Manage Messages | 4   | Edit/delete others' messages |
| Manage Channels | 8   | Create, edit, delete channels |
| Manage Roles | 16  | Create, edit, assign roles |
| Manage Server | 32  | Change server settings, invites |
| Administrator | 64  | All of the above |

Every user inherits the `@everyone` role. Additional roles stack on top. The server **owner** always has all permissions regardless of assigned roles.

---

## Invites

By default, registration is open. You can:

- **Disable registration** entirely (Settings → Allow Registration → Off)
- **Require invite codes** (Settings → Require Invite Code → Yes)

Generate invite links in the Admin Panel → Invites tab. Each invite can have an optional max-use count and expiry date.

---

## Architecture

```
chirm/
├── main.go                        Entry point, router, TLS, .env loader
├── .env.example                   Documented env var template
├── internal/
│   ├── auth/
│   │   ├── auth.go                JWT generation, bcrypt hashing, token validation
│   │   └── totp.go                TOTP secret generation & validation
│   ├── config/config.go           Environment variable parsing, .env loader
│   ├── crypto/crypto.go           AES-256-GCM encryption, HKDF key derivation
│   ├── db/
│   │   ├── store.go               Store struct, New(), permission constants, NewID()
│   │   ├── channel_store.go       ChannelStore — lazy-open per-channel *sql.DB cache
│   │   ├── migrate.go             Embedded migration runner (server/members/auth/channel)
│   │   ├── models.go              Shared types: User, Channel, Message, Thread, Bot …
│   │   ├── messages.go            Message / attachment / reaction queries (channel DBs)
│   │   ├── threads.go             Thread create/list/delete, thread_index maintenance
│   │   ├── channels.go            Channel + category CRUD (server.db)
│   │   ├── users.go / roles.go    User and role queries (members.db)
│   │   ├── bots.go                Bot token management (server.db)
│   │   ├── csrf.go / totp.go …    Auth-tier queries (auth.db)
│   │   └── propagate.go           PropagateProfileUpdate, PropagateBotRename, ReconcileStorageUsed
│   ├── events/                    Domain event bus (types + pub/sub)
│   ├── hub/                       WebSocket hub, voice rooms
│   ├── logger/logger.go           Audit logging with daily rotation
│   ├── middleware/
│   │   ├── middleware.go          JWT + bot-token auth, security headers
│   │   └── ratelimit.go          Per-IP rate limiting
│   ├── plugin/
│   │   ├── plugin.go              Plugin interface and sandboxed context
│   │   └── registry.go            Plugin registry
│   ├── router/router.go           Route registration (/api/v1/*)
│   └── handlers/
│       ├── handlers.go            Handler struct, WS upgrader, helpers
│       ├── hub.go                 WebSocket message dispatch, voice rooms, WebRTC relay
│       ├── setup.go               First-run setup
│       ├── admin.go               Admin-only operations
│       ├── auth.go                Login, register, logout, TOTP, profile update
│       ├── channels.go            Channel & category CRUD, reordering
│       ├── messages.go            Message CRUD, replies, reactions, pagination
│       ├── threads.go             Thread CRUD, thread message send/list
│       ├── users.go               User & role management, invites, settings
│       ├── bots.go                Bot management (admin)
│       ├── uploads.go             File upload with MIME validation
│       ├── emojis.go              Custom emoji upload & management
│       ├── linkpreview.go         OpenGraph link preview fetcher with cache
│       └── push.go                VAPID key management, Web Push encryption
└── static/
    ├── index.html                 Main app shell (SPA)
    ├── login.html                 Login / register page
    ├── setup.html                 Setup wizard
    ├── manifest.json              PWA manifest
    ├── sw.js                      Service worker (push, caching)
    ├── css/app.css                Full App Theming (~2400 lines)
    └── js/
        ├── app.js                 Application coordinator, boot, event handlers
        ├── api.js                 HTTP client wrapper
        ├── ws.js                  WebSocket client with auto-reconnect
        ├── voice.js               WebRTC voice/video/screen sharing manager (~1150 lines)
        ├── state.js               Global app state (channels, users, messages)
        ├── notifications.js       Push subscription, in-app toasts, SW coordination
        ├── mentions.js            @mention autocomplete engine
        ├── user-settings.js       Local user preferences (mutes, notification prefs)
        ├── cache.js               Per-channel message cache with TTL & LRU eviction
        ├── theme.js               Dark/light mode toggle
        ├── utils.js               Escaping, formatting, helpers
        ├── emoji-data.js          Built-in emoji dataset
        └── render/                UI rendering modules
            ├── admin.js           Admin panel
            ├── media.js           Image viewer, upload previews
            ├── members.js         Member list, status picker
            ├── messages.js        Message rendering, emoji picker
            ├── modals.js          Modal dialogs
            ├── sidebar.js         Channel & category sidebar
            └── threads.js         Thread panel, forum/gallery views
```

Static files are **embedded in the binary** via Go's `//go:embed` directive. Deploying means copying a single file.

---

## API Reference

All endpoints are under `/api/v1/`. The legacy `/api/` prefix redirects automatically.

### Auth

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/v1/setup` | First-run setup |
| `GET` | `/api/v1/setup/status` | Check if setup is complete |
| `POST` | `/api/v1/auth/login` | Login (rate-limited) |
| `POST` | `/api/v1/auth/register` | Register (rate-limited) |
| `POST` | `/api/v1/auth/logout` | Logout |
| `POST` | `/api/v1/auth/totp` | Complete TOTP second step (pending session token) |
| `POST` | `/api/v1/auth/refresh` | Rotate refresh token, get new access JWT |
| `GET` | `/api/v1/me` | Get current user |
| `PUT` | `/api/v1/me` | Update profile |
| `POST` | `/api/v1/me/avatar` | Upload avatar |
| `POST` | `/api/v1/me/banner` | Upload profile banner |
| `PUT` | `/api/v1/me/status` | Update online status |
| `POST` | `/api/v1/me/totp/setup` | Generate TOTP secret |
| `POST` | `/api/v1/me/totp/confirm` | Activate TOTP (verify first code) |
| `DELETE` | `/api/v1/me/totp` | Disable TOTP |
| `GET` | `/api/v1/public-settings` | Get public server settings |
| `GET` | `/api/v1/join/{code}` | Validate invite code |

### Channels & Categories

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/api/v1/channels` | Any |
| `POST` | `/api/v1/channels` | Admin |
| `PUT` | `/api/v1/channels/{id}` | Admin |
| `DELETE` | `/api/v1/channels/{id}` | Admin |
| `POST` | `/api/v1/channels/reorder` | Admin |
| `GET` | `/api/v1/channel-categories` | Any |
| `POST` | `/api/v1/channel-categories` | Admin |
| `PUT` | `/api/v1/channel-categories/{id}` | Admin |
| `DELETE` | `/api/v1/channel-categories/{id}` | Admin |
| `POST` | `/api/v1/channel-categories/reorder` | Admin |

### Messages & Reactions

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/api/v1/channels/{id}/messages` | Any |
| `POST` | `/api/v1/channels/{id}/messages` | Any |
| `PUT` | `/api/v1/messages/{id}` | Author/Admin |
| `DELETE` | `/api/v1/messages/{id}` | Author/Admin |
| `POST` | `/api/v1/messages/{id}/reactions` | Any |
| `DELETE` | `/api/v1/messages/{id}/reactions` | Any |

### Threads

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/api/v1/channels/{id}/threads` | Any |
| `POST` | `/api/v1/channels/{id}/threads` | Any |
| `DELETE` | `/api/v1/threads/{id}` | Author/Admin |
| `GET` | `/api/v1/threads/{id}/messages` | Any |
| `POST` | `/api/v1/threads/{id}/messages` | Any |
| `GET` | `/api/v1/threads/{id}/first-message` | Any |

### Custom Emoji

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/api/v1/emojis` | Any |
| `POST` | `/api/v1/emojis` | Admin |
| `DELETE` | `/api/v1/emojis/{id}` | Admin |

### Users, Roles & Invites

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/api/v1/users` | Admin |
| `GET` | `/api/v1/users/{id}` | Any |
| `PUT` | `/api/v1/users/{id}` | Admin |
| `DELETE` | `/api/v1/users/{id}` | Admin |
| `GET` | `/api/v1/members` | Any |
| `GET` | `/api/v1/roles` | Any |
| `POST` | `/api/v1/roles` | Admin |
| `PUT` | `/api/v1/roles/{id}` | Admin |
| `DELETE` | `/api/v1/roles/{id}` | Admin |
| `POST` | `/api/v1/users/{id}/roles/{roleId}` | Admin |
| `DELETE` | `/api/v1/users/{id}/roles/{roleId}` | Admin |
| `GET` | `/api/v1/invites` | Admin |
| `POST` | `/api/v1/invites` | Admin |
| `DELETE` | `/api/v1/invites/{code}` | Admin |

### Bots

Bots authenticate using `Authorization: Bearer chirm_bot_<token>` instead of a user JWT.

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/api/v1/bots` | Admin |
| `POST` | `/api/v1/bots` | Admin |
| `PUT` | `/api/v1/bots/{id}` | Admin |
| `DELETE` | `/api/v1/bots/{id}` | Admin |
| `POST` | `/api/v1/bots/{id}/regenerate-token` | Admin |

### Server Settings

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/api/v1/settings` | Admin |
| `PUT` | `/api/v1/settings` | Admin |
| `POST` | `/api/v1/settings/icon` | Admin |
| `POST` | `/api/v1/settings/login-bg` | Admin |

### Files & Previews

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/api/v1/upload` | Any |
| `GET` | `/api/v1/uploads/{filename}` | Any |
| `GET` | `/uploads/{filename}` | Public (server icons, login backgrounds) |
| `GET` | `/api/v1/link-preview` | Any |

### Push Notifications

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/api/v1/push/vapid-public-key` | Any |
| `POST` | `/api/v1/push/subscribe` | Any |
| `POST` | `/api/v1/push/unsubscribe` | Any |
| `GET` | `/api/v1/push/poll` | Any |
| `POST` | `/api/v1/push/test` | Any |

### Voice

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/api/v1/voice/rooms` | Any |

### TLS

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/ca-cert` | Public |

### WebSocket

`GET /ws` — Authenticated. Send/receive JSON events:

**Client → Server:**

```json
{ "type": "subscribe",          "data": { "channel_id": "..." } }
{ "type": "thread_subscribe",   "data": { "channel_id": "..." } }
{ "type": "typing",             "data": { "channel_id": "..." } }
{ "type": "voice.join",         "data": { "channel_id": "..." } }
{ "type": "voice.leave",        "data": { "channel_id": "..." } }
{ "type": "voice.offer",        "data": { "channel_id": "...", "target_user_id": "...", "payload": {} } }
{ "type": "voice.answer",       "data": { "channel_id": "...", "target_user_id": "...", "payload": {} } }
{ "type": "voice.ice",          "data": { "channel_id": "...", "target_user_id": "...", "payload": {} } }
{ "type": "voice.media_state",  "data": { "channel_id": "...", "cam_enabled": false, "screen_sharing": false } }
```

**Server → Client:**

```json
{ "type": "message.new",            "data": { ...message } }
{ "type": "message.edit",           "data": { ...message } }
{ "type": "message.delete",         "data": { "id": "...", "channel_id": "..." } }
{ "type": "message.activity",       "data": { "channel_id": "...", "channel_name": "...", "author_id": "...", "author": "...", "preview": "...", "message_id": "..." } }
{ "type": "thread.new",             "data": { "thread": {...}, "channel_id": "..." } }
{ "type": "thread.delete",          "data": { "thread_id": "...", "channel_id": "..." } }
{ "type": "thread.message.new",     "data": { ...message } }
{ "type": "thread.message.delete",  "data": { "id": "...", "thread_id": "...", "channel_id": "..." } }
{ "type": "channel.new",            "data": { ...channel } }
{ "type": "channel.update",         "data": { ...channel } }
{ "type": "channel.delete",         "data": { "id": "..." } }
{ "type": "channels.reorder",       "data": [ ...channels ] }
{ "type": "category.new",           "data": { ...category } }
{ "type": "categories.update",      "data": [ ...categories ] }
{ "type": "category.delete",        "data": { "id": "...", "channels": [...] } }
{ "type": "member.new",             "data": { ...user } }
{ "type": "member.leave",           "data": { "id": "..." } }
{ "type": "member.update",          "data": { "id": "...", "username": "...", "avatar": "..." } }
{ "type": "member.status",          "data": { "id": "...", "status": "..." } }
{ "type": "typing",                 "data": { "user_id": "...", "channel_id": "..." } }
{ "type": "reaction.update",        "data": { "message_id": "...", "channel_id": "...", "reactions": [...] } }
{ "type": "voice.room_state",       "data": { "channel_id": "...", "participants": ["..."] } }
{ "type": "voice.joined",           "data": { "channel_id": "...", "user_id": "..." } }
{ "type": "voice.left",             "data": { "channel_id": "...", "user_id": "..." } }
{ "type": "voice.offer",            "data": { "channel_id": "...", "from_user_id": "...", "payload": {} } }
{ "type": "voice.answer",           "data": { "channel_id": "...", "from_user_id": "...", "payload": {} } }
{ "type": "voice.ice",              "data": { "channel_id": "...", "from_user_id": "...", "payload": {} } }
{ "type": "voice.media_state",      "data": { "channel_id": "...", "from_user_id": "...", "cam_enabled": false, "screen_sharing": false } }
{ "type": "emoji.new",              "data": { ...emoji } }
{ "type": "emoji.delete",           "data": { "id": "..." } }
```

---

## Backup

Your data lives entirely in `DATA_DIR` (default `./data`):

```
data/
├── server.db      ← channels, categories, settings, bots, custom emojis, invites
├── members.db     ← users, roles, push subscriptions
├── auth.db        ← sessions, refresh tokens, TOTP state, login lockouts
├── channels/      ← one SQLite file per channel and per thread
│   └── {id}.db
└── uploads/       ← uploaded files
```

To back up, just copy this directory. To restore, replace it.

```bash
# Backup
cp -r ./data ./data-backup-$(date +%Y%m%d)
```

## TLS / HTTPS

Chirm serves HTTPS out of the box. Certificate priority:

1. **Environment variables** — `CHIRM_TLS_CERT` / `CHIRM_TLS_KEY` (e.g. Let's Encrypt, Tailscale)
2. **`certs/` directory** — drop `cert.pem` + `key.pem` into `./certs/`
3. **Built-in CA** *(default)* — auto-generates a persistent local CA on first run, signs a server cert, and serves the CA at `GET /ca-cert` for easy device trust

To trust the built-in CA on a device, visit `http://<server-ip>:8080/ca-cert` and install the downloaded certificate.

Android and iOS will prompt to add it as a trusted CA.

---

## Production Notes

- Set a strong `JWT_SECRET` — at least 32 random hex characters
  
- Put Chirm behind a reverse proxy (nginx / Caddy / Traefik) for public-facing HTTPS
  
- For nginx, proxy both HTTP and WebSocket:
  
  ```nginx
  location / {
      proxy_pass http://127.0.0.1:8080;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
  }
  ```
  

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Language | Go 1.22 |
| Router | [chi](https://github.com/go-chi/chi) |
| Database | SQLite via [modernc.org/sqlite](https://pkg.go.dev/modernc.org/sqlite) (pure Go, no CGO) |
| WebSocket | [gorilla/websocket](https://github.com/gorilla/websocket) |
| Auth | JWT ([golang-jwt](https://github.com/golang-jwt/jwt)) + bcrypt + TOTP |
| Voice/Video | WebRTC (browser-native), mesh P2P topology |
| Push | Web Push with VAPID (hand-rolled, zero dependencies) |
| Frontend | Vanilla HTML/CSS/JS, no build step |

---

## Contributing

1. Fork the repo and create a feature branch
2. No build tools required for the frontend — edit vanilla HTML/CSS/JS in `static/`
3. Backend changes: `go build -o chirm . && ./chirm`
4. Open a pull request describing what you changed and why

---

## License

AGPLv3
