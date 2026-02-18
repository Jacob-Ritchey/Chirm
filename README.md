# ✦ Nexus

**Self-hosted community chat.** Discord-style messaging for your Raspberry Pi, VPS, or home server. Single binary, SQLite database, zero external dependencies.

---

## Features

- **Real-time messaging** via WebSockets
- **Multiple channels** with history and pagination
- **Roles & permissions** with granular bitmask control
- **File & image uploads** (configurable size limit)
- **Invite system** for controlled registration
- **Admin panel** in-app — manage users, roles, channels, settings
- **Single binary** — embed static assets, no nginx required
- **SQLite** — one file, zero-setup database, easy backups
- **Docker ready** — compose file included for instant deployment
- **ARM compatible** — runs on Raspberry Pi (pure Go, no CGO)

---

## Quick Start

### Option 1: Docker Compose (Recommended)

```bash
git clone https://github.com/yourname/nexus
cd nexus

# Create .env from example
cp .env.example .env
# Edit JWT_SECRET in .env !

docker compose up -d
```

Open `http://localhost:8080` and follow the setup wizard.

### Option 2: Build from Source

**Requirements:** Go 1.21+

```bash
git clone https://github.com/yourname/nexus
cd nexus

go mod tidy
go build -o nexus .

# Run
JWT_SECRET=your-secret-here ./nexus
```

Open `http://localhost:8080`.

### Option 3: Raspberry Pi

```bash
# On your Pi (or cross-compile from x86)
GOOS=linux GOARCH=arm64 go build -o nexus-arm64 .

# Transfer to Pi, then:
chmod +x nexus-arm64
JWT_SECRET=your-secret ./nexus-arm64
```

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `DATA_DIR` | `./data` | Directory for SQLite DB and uploads |
| `JWT_SECRET` | *(required in prod)* | Secret for signing JWTs — use a long random string |

---

## First Run Setup

On first visit, you'll be directed to `/setup` — a wizard that:

1. Names your server
2. Creates the owner/admin account
3. Creates a `#general` channel
4. Sets up the `@everyone` role

---

## Permissions System

Permissions use a bitmask stored on roles:

| Permission | Value | Description |
|---|---|---|
| Read Messages | 1 | View channels and history |
| Send Messages | 2 | Post messages |
| Manage Messages | 4 | Edit/delete others' messages |
| Manage Channels | 8 | Create, edit, delete channels |
| Manage Roles | 16 | Create, edit, assign roles |
| Manage Server | 32 | Change server settings, invites |
| Administrator | 64 | All of the above |

Every user inherits the `@everyone` role. Additional roles stack on top. The server **owner** always has all permissions.

---

## Invites

By default, registration is open. You can:
- **Disable registration** entirely (Settings → Allow Registration → Disabled)
- **Require invite codes** (Settings → Require Invite Code → Yes)

Generate invite links in the Admin Panel → Invites tab. Share the link — it pre-fills the invite code on the register page.

---

## Architecture

```
nexus/
├── main.go                      Entry point, router setup
├── internal/
│   ├── auth/auth.go             JWT generation & bcrypt hashing
│   ├── db/db.go                 SQLite schema, models, all queries
│   ├── middleware/middleware.go  JWT auth middleware
│   └── handlers/
│       ├── handlers.go          Handler struct, WS upgrader, helpers
│       ├── hub.go               WebSocket hub (broadcast, subscriptions)
│       ├── setup.go             First-run setup
│       ├── auth.go              Login, register, logout
│       ├── channels.go          Channel CRUD
│       ├── messages.go          Message CRUD + pagination
│       ├── users.go             User & role management, invites, settings
│       └── uploads.go           File upload handler
└── static/
    ├── index.html               Main app shell
    ├── login.html               Login / register page
    ├── setup.html               Setup wizard
    ├── css/app.css              Full Discord-style dark theme
    └── js/
        ├── ws.js                WebSocket client with auto-reconnect
        └── app.js               Application logic, rendering, admin panel
```

Static files are **embedded in the binary** via Go's `//go:embed` directive, so deploying is just copying the single `nexus` file.

---

## API Reference

### Auth
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/setup` | First-run setup |
| `POST` | `/api/auth/login` | Login |
| `POST` | `/api/auth/register` | Register |
| `POST` | `/api/auth/logout` | Logout |
| `GET` | `/api/me` | Get current user |
| `PUT` | `/api/me` | Update profile |

### Channels
| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/channels` | Any |
| `POST` | `/api/channels` | Admin |
| `PUT` | `/api/channels/:id` | Admin |
| `DELETE` | `/api/channels/:id` | Admin |

### Messages
| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/channels/:id/messages` | Any |
| `POST` | `/api/channels/:id/messages` | Any |
| `PUT` | `/api/messages/:id` | Author/Admin |
| `DELETE` | `/api/messages/:id` | Author/Admin |

### Users & Roles
| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/users` | Admin |
| `DELETE` | `/api/users/:id` | Admin |
| `GET` | `/api/roles` | Any |
| `POST` | `/api/roles` | Admin |
| `PUT` | `/api/roles/:id` | Admin |
| `DELETE` | `/api/roles/:id` | Admin |
| `POST` | `/api/users/:id/roles/:roleId` | Admin |
| `DELETE` | `/api/users/:id/roles/:roleId` | Admin |

### Files
| Method | Path | Auth |
|---|---|---|
| `POST` | `/api/upload` | Any |
| `GET` | `/uploads/:filename` | Public |

### WebSocket
`GET /ws` — Authenticated. Send/receive JSON events:

**Client → Server:**
```json
{ "type": "subscribe", "data": { "channel_id": "abc123" } }
{ "type": "typing",    "data": { "channel_id": "abc123" } }
```

**Server → Client:**
```json
{ "type": "message.new",      "data": { ...message } }
{ "type": "message.edit",     "data": { ...message } }
{ "type": "message.delete",   "data": { "id": "...", "channel_id": "..." } }
{ "type": "channel.new",      "data": { ...channel } }
{ "type": "channel.update",   "data": { ...channel } }
{ "type": "channel.delete",   "data": { "id": "..." } }
{ "type": "typing",           "data": { "user_id": "...", "channel_id": "..." } }
```

---

## Backup

Your data lives entirely in `DATA_DIR` (default `./data`):

```
data/
├── nexus.db       ← SQLite database (all messages, users, settings)
└── uploads/       ← Uploaded files
```

To back up, just copy this directory. To restore, replace it.

```bash
# Backup
cp -r ./data ./data-backup-$(date +%Y%m%d)

# Or with Docker
docker run --rm -v nexus_nexus-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/nexus-backup.tar.gz -C /data .
```

---

## Production Notes

- Set a strong `JWT_SECRET` — at least 32 random characters
- Put Nexus behind a reverse proxy (nginx/Caddy/Traefik) for HTTPS
- The `docker-compose.yml` has commented Traefik labels as a starting point
- For nginx, proxy `http://nexus:8080` and pass WebSocket upgrade headers:
  ```nginx
  location / {
      proxy_pass http://127.0.0.1:8080;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
  }
  ```

---

## License

MIT
