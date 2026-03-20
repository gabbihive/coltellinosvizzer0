# server-express

Self-hosted tools platform with an admin control panel. Built with Node.js and Express. Fully in-memory — no database. Deployed on Render.

## Tools

### Dead Drop

Zero-knowledge encrypted paste bin at `/drop`. Designed for sharing sensitive text anonymously.

- **Client-side AES-256-GCM encryption** — content is encrypted in the browser before reaching the server
- **Key in URL fragment** — the decryption key is after `#` in the URL, which browsers never send to the server
- **Burn after reading** — optionally destroy the message after one view
- **Auto-expiry** — 1 hour, 24 hours, 7 days, or 30 days
- **No traces** — no logging, no IP tracking, no cookies, no metadata on drop routes
- **In-memory storage** — drops are never written to disk, lost on restart
- **256 KB max** per paste

The server stores only ciphertext in memory. It cannot read drop contents even if compromised.

### Signal Room

Zero-knowledge encrypted ephemeral chat at `/chat`. Real-time messaging where the server is a dumb relay.

- **Client-side AES-256-GCM encryption** — messages encrypted in browser before transmission
- **Key in URL fragment** — decryption key never leaves your URL bar
- **WebSocket relay** — server forwards opaque ciphertext, cannot decrypt anything
- **Fully ephemeral** — no messages stored anywhere (not even in memory)
- **No traces** — no logging, no IP tracking, no metadata on chat routes
- **Rooms auto-destroy** when the last participant disconnects

### File Drop

Zero-knowledge encrypted file sharing at `/file`. Share files anonymously with automatic metadata stripping.

- **Client-side AES-256-GCM encryption** — files encrypted in browser before upload
- **Key in URL fragment** — decryption key never sent to the server
- **Automatic EXIF stripping** — image metadata (GPS, camera info, timestamps) removed via Canvas re-render
- **Encrypted metadata** — filename and file type are encrypted separately, server never sees them
- **Burn after download** — optionally destroy the file after one download
- **Auto-expiry** — 1 hour, 24 hours, 7 days, or 30 days
- **No traces** — no logging, no IP tracking, no cookies, no metadata on file routes
- **In-memory storage** — files are never written to disk, lost on restart
- **10 MB max** per file, 500 MB total storage
- **Upload rate limiting** — 20 uploads per IP per hour

## Admin Panel

Authenticated control panel at `/panel` (login at `/login.html`).

**Tabs:**
- **Dashboard** — uptime, memory, active drops, active files, chat rooms/peers, request log
- **Drops** — view/delete encrypted drops, purge expired, stats
- **Files** — view/delete encrypted files, purge expired, storage stats
- **Settings** — change password, environment variables, system info

## Local Development

### Prerequisites

- Node.js >= 18

### Setup

```bash
npm install
cp .env.example .env    # fill in ADMIN_PASSWORD
npm run dev
```

Open `http://localhost:3000` — the tools index. Admin panel at `/panel`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `ADMIN_USERNAME` | `admin` | Admin login username |
| `ADMIN_PASSWORD` | — | **Required.** Admin login password |
| `SESSION_SECRET` | random | Session cookie signing secret (set in production) |

## Security

- **Login rate limiting** — 5 attempts per IP per minute
- **File upload rate limiting** — 20 uploads per IP per hour
- **CSRF origin checking** on all state-changing requests
- **Security headers** — X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy no-referrer, HSTS in production
- **WebSocket origin validation** — only allowed origins can connect
- **scrypt password hashing** with random salt (env var password hashed at startup)
- **Timing-safe comparison** (prevents timing attacks)
- **httpOnly, sameSite lax, secure cookies**
- **Connection limits** — per-IP (10), global (500), per-room (50), max rooms (1000)
- **Rate limiting** — 10 WebSocket messages/sec per connection
- **Allowlist-based env var exposure** in system info API
- **Image metadata stripping** — EXIF/GPS/camera data removed client-side

## API

All `/api/*` endpoints require authentication except `/api/drop`, `/api/file`, and `/api/chat` (public).

### Public (no auth)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/drop` | Create encrypted drop (`{ encrypted, iv, burn?, expiry? }`) |
| `GET` | `/api/drop/:id` | Retrieve encrypted drop (deletes if burn-after-read) |
| `POST` | `/api/file` | Create encrypted file (`{ encrypted, iv, encryptedMeta, metaIv, burn?, expiry? }`) |
| `GET` | `/api/file/:id` | Retrieve encrypted file (deletes if burn-after-download) |

### Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/auth/login` | Login (`{ username, password }`) |
| `POST` | `/auth/logout` | Logout |
| `GET` | `/auth/check` | Check auth status |
| `POST` | `/auth/change-password` | Change password (`{ currentPassword, newPassword }`) |

### Admin (auth required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status` | Server health |
| `GET` | `/api/drops` | List all drops (metadata only) |
| `GET` | `/api/drops/stats` | Drop statistics |
| `DELETE` | `/api/drops/:id` | Delete a drop |
| `POST` | `/api/drops/purge-expired` | Delete all expired drops |
| `GET` | `/api/files` | List all files (metadata only) |
| `GET` | `/api/files/stats` | File statistics |
| `DELETE` | `/api/files/:id` | Delete a file |
| `POST` | `/api/files/purge-expired` | Delete all expired files |
| `GET` | `/api/chat/stats` | Chat room/peer counts |
| `GET` | `/api/system` | System info + env vars (allowlisted) |
| `GET` | `/api/logs` | Request log (last 200) |

## Project Structure

```
src/
  server.js              # Express app, all routes, WebSocket relay
  public/
    landing.html         # Tools index (/)
    drop.html            # Dead Drop UI (/drop)
    chat.html            # Signal Room UI (/chat)
    file.html            # File Drop UI (/file)
    index.html           # Admin panel (/panel)
    login.html           # Login page
```

## Deploying to Render

1. Push to GitHub
2. Create a Web Service, connect the repo
3. Set `ADMIN_PASSWORD`, `SESSION_SECRET` in Environment
4. Build command: `npm install`
5. Start command: `npm start`

No database required. Auto-deploys on push.
