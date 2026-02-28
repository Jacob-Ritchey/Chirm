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

**Self-hosted community chat.** Real-Time Messaging with voice, video, and screen sharing for your Raspberry Pi, VPS, or home server. Single binary, SQLite database, zero external dependencies.

> *The Wren may be small, but its song fills the forest.*

---

## Features

### Messaging

- **Real-time chat** via WebSockets with auto-reconnect
- **Multiple channels** organized into collapsible categories with drag-to-reorder
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
- **Configurable size limit** — set max upload size per server (default 25 MB)
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
- **User avatars** — each member can upload their own profile image
- **Channel emoji** — assign an emoji icon to any channel

### Security & Deployment

- **Single binary** — Go's `//go:embed` bundles all static assets, no web server required
- **SQLite + WAL** — one-file database, zero-setup, easy backups
- **Auto-TLS** — generates a persistent local CA and signed server certificate on first run; serves the CA at `/ca-cert` for one-click device trust
- **Custom TLS** — bring your own certs (Let's Encrypt, Tailscale, mkcert) via env vars or `certs/` directory
- **Per-IP rate limiting** — auth endpoints are throttled to prevent brute-force
- **WebSocket message limits** — 64 KB cap prevents memory-exhaustion attacks
- **Docker ready** — multi-stage Dockerfile and compose file included
- **ARM compatible** — pure Go (no CGO), runs natively on Raspberry Pi
- **Healthcheck** — Docker healthcheck pings `/api/setup/status`

---

## Quick Start

**Requirements:** Go 1.22+

## Docker Setup (Recommended)

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
| `PORT` | `8080` | HTTP listen port |
| `HTTPS_PORT` | `8443` | HTTPS listen port |
| `DATA_DIR` | `./data` | Directory for SQLite DB and uploads |
| `CHIRM_TLS_CERT` | *(auto)* | Path to a custom TLS certificate |
| `CHIRM_TLS_KEY` | *(auto)* | Path to a custom TLS private key |
| `ALLOWED_ORIGIN` | *(same-host)* | Full origin for WebSocket upgrades behind a reverse proxy |

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
├── main.go                      Entry point, router, TLS, .env loader
├── .env.example                 Documented env var template
├── internal/
│   ├── auth/auth.go             JWT generation & bcrypt hashing
│   ├── db/db.go                 SQLite schema, models, all queries
│   ├── middleware/middleware.go  JWT auth middleware
│   └── handlers/
│       ├── handlers.go          Handler struct, WS upgrader, helpers
│       ├── hub.go               WebSocket hub — broadcast, voice rooms, WebRTC relay
│       ├── setup.go             First-run setup
│       ├── auth.go              Login, register, logout
│       ├── channels.go          Channel & category CRUD, reordering
│       ├── messages.go          Message CRUD, replies, reactions, pagination
│       ├── users.go             User & role management, invites, settings
│       ├── uploads.go           File upload with MIME validation
│       ├── emojis.go            Custom emoji upload & management
│       ├── linkpreview.go       OpenGraph link preview fetcher with cache
│       └── push.go              VAPID key management, Web Push encryption
└── static/
    ├── index.html               Main app shell (SPA)
    ├── login.html               Login / register page
    ├── setup.html               Setup wizard
    ├── manifest.json            PWA manifest
    ├── sw.js                    Service worker (push, caching)
    ├── css/app.css              Discord-style dark theme (~2400 lines)
    └── js/
        ├── app.js               Application logic, rendering, admin panel (~3000 lines)
        ├── ws.js                WebSocket client with auto-reconnect
        ├── voice.js             WebRTC voice/video/screen sharing manager (~1150 lines)
        ├── notifications.js     Push subscription, in-app toasts, SW coordination
        ├── mentions.js          @mention autocomplete engine
        ├── user-settings.js     Local user preferences (mutes, notification prefs)
        ├── cache.js             Per-channel message cache with TTL & LRU eviction
        └── emoji-data.js        Built-in emoji dataset
```

Static files are **embedded in the binary** via Go's `//go:embed` directive. Deploying means copying a single file.

---

## API Reference

### Auth

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/setup` | First-run setup |
| `GET` | `/api/setup/status` | Check if setup is complete |
| `POST` | `/api/auth/login` | Login (rate-limited) |
| `POST` | `/api/auth/register` | Register (rate-limited) |
| `POST` | `/api/auth/logout` | Logout |
| `GET` | `/api/me` | Get current user |
| `PUT` | `/api/me` | Update profile |
| `POST` | `/api/me/avatar` | Upload avatar |
| `GET` | `/api/public-settings` | Get public server settings |
| `GET` | `/api/join/{code}` | Validate invite code |

### Channels & Categories

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/api/channels` | Any |
| `POST` | `/api/channels` | Admin |
| `PUT` | `/api/channels/{id}` | Admin |
| `DELETE` | `/api/channels/{id}` | Admin |
| `POST` | `/api/channels/reorder` | Admin |
| `GET` | `/api/channel-categories` | Any |
| `POST` | `/api/channel-categories` | Admin |
| `PUT` | `/api/channel-categories/{id}` | Admin |
| `DELETE` | `/api/channel-categories/{id}` | Admin |
| `POST` | `/api/channel-categories/reorder` | Admin |

### Messages & Reactions

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/api/channels/{id}/messages` | Any |
| `POST` | `/api/channels/{id}/messages` | Any |
| `PUT` | `/api/messages/{id}` | Author/Admin |
| `DELETE` | `/api/messages/{id}` | Author/Admin |
| `POST` | `/api/messages/{id}/reactions` | Any |
| `DELETE` | `/api/messages/{id}/reactions/{emoji}` | Any |

### Custom Emoji

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/api/emojis` | Any |
| `POST` | `/api/emojis` | Any |
| `DELETE` | `/api/emojis/{id}` | Admin |

### Users, Roles & Invites

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/api/users` | Admin |
| `PUT` | `/api/users/{id}` | Admin |
| `DELETE` | `/api/users/{id}` | Admin |
| `GET` | `/api/members` | Any |
| `GET` | `/api/roles` | Any |
| `POST` | `/api/roles` | Admin |
| `PUT` | `/api/roles/{id}` | Admin |
| `DELETE` | `/api/roles/{id}` | Admin |
| `POST` | `/api/users/{id}/roles/{roleId}` | Admin |
| `DELETE` | `/api/users/{id}/roles/{roleId}` | Admin |
| `GET` | `/api/invites` | Admin |
| `POST` | `/api/invites` | Admin |
| `DELETE` | `/api/invites/{code}` | Admin |

### Server Settings

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/api/settings` | Admin |
| `PUT` | `/api/settings` | Admin |
| `POST` | `/api/settings/icon` | Admin |
| `POST` | `/api/settings/login-bg` | Admin |

### Files & Previews

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/api/upload` | Any |
| `GET` | `/uploads/{filename}` | Public |
| `GET` | `/api/link-preview` | Any |

### Push Notifications

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/api/push/vapid-public-key` | Any |
| `POST` | `/api/push/subscribe` | Any |
| `POST` | `/api/push/unsubscribe` | Any |
| `GET` | `/api/push/poll` | Any |
| `POST` | `/api/push/test` | Any |

### Voice

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/api/voice/rooms` | Any |

### TLS

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/ca-cert` | Public |

### WebSocket

`GET /ws` — Authenticated. Send/receive JSON events:

**Client → Server:**

```json
{ "type": "subscribe",          "data": { "channel_id": "..." } }
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
{ "type": "message.new",       "data": { ...message } }
{ "type": "message.edit",      "data": { ...message } }
{ "type": "message.delete",    "data": { "id": "...", "channel_id": "..." } }
{ "type": "channel.new",       "data": { ...channel } }
{ "type": "channel.update",    "data": { ...channel } }
{ "type": "channel.delete",    "data": { "id": "..." } }
{ "type": "typing",            "data": { "user_id": "...", "channel_id": "..." } }
{ "type": "voice.room_state",  "data": { "channel_id": "...", "participants": ["..."] } }
{ "type": "voice.joined",      "data": { "channel_id": "...", "user_id": "..." } }
{ "type": "voice.left",        "data": { "channel_id": "...", "user_id": "..." } }
{ "type": "voice.offer",       "data": { "channel_id": "...", "from_user_id": "...", "payload": {} } }
{ "type": "voice.answer",      "data": { "channel_id": "...", "from_user_id": "...", "payload": {} } }
{ "type": "voice.ice",         "data": { "channel_id": "...", "from_user_id": "...", "payload": {} } }
{ "type": "voice.media_state", "data": { "channel_id": "...", "from_user_id": "...", "cam_enabled": false, "screen_sharing": false } }
{ "type": "reaction.add",      "data": { "message_id": "...", "user_id": "...", "emoji": "..." } }
{ "type": "reaction.remove",   "data": { "message_id": "...", "user_id": "...", "emoji": "..." } }
```

---

## Backup

Your data lives entirely in `DATA_DIR` (default `./data`):

```
data/
├── chirm.db       ← SQLite database (all messages, users, settings)
└── uploads/       ← Uploaded files
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
| Language | Go 1.21 |
| Router | [chi](https://github.com/go-chi/chi) |
| Database | SQLite via [modernc.org/sqlite](https://pkg.go.dev/modernc.org/sqlite) (pure Go, no CGO) |
| WebSocket | [gorilla/websocket](https://github.com/gorilla/websocket) |
| Auth | JWT ([golang-jwt](https://github.com/golang-jwt/jwt)) + bcrypt |
| Voice/Video | WebRTC (browser-native), mesh P2P topology |
| Push | Web Push with VAPID (hand-rolled, zero dependencies) |
| Frontend | Vanilla HTML/CSS/JS, no build step |

---

## License

AGPLv3
