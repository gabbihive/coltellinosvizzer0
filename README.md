# coltellinosvizzer0

Self-hosted secure communicatons platform. Built with Node.js and Express. Fully in-memory — no database.



<img width="473" height="184" alt="ascii-art-text" src="https://github.com/user-attachments/assets/af7d8e09-6f95-4a14-b196-619b80be4b8a" />
                                          
                                                         

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
- **Forward secrecy** — symmetric key ratcheting via HKDF chain derivation; past messages protected if current key is compromised
- **Fully ephemeral** — no messages stored anywhere (not even in memory)
- **No traces** — no logging, no IP tracking, no metadata on chat routes
- **Room access control** — HKDF-derived access tokens + invite tokens (one concurrent connection per token, reconnectable)
- **Deterministic rendezvous** — passphrase-based room derivation via PBKDF2/HKDF (no URL sharing needed), with Diceware generator (2048-word wordlist, 66-bit entropy), entropy estimator, and minimum strength enforcement
- **Callsign system** — optional pre-agreed aliases, encrypted in message payload
- **Participant verification** — SHA-256 safety numbers for out-of-band identity verification
- **Message padding** — fixed bucket sizes to prevent traffic analysis
- **24-hour room lifetime** — server-enforced with client countdown
- **2-minute inactivity timeout** — warning at 90s, auto-disconnect at 120s
- **Rooms auto-destroy** when the last participant disconnects

### File Drop

Zero-knowledge encrypted file sharing at `/file`. Share files anonymously with automatic metadata stripping.

- **Client-side AES-256-GCM encryption** — files encrypted in browser before upload
- **Key in URL fragment** — decryption key never sent to the server
- **Byte-level metadata stripping** — JPEG (APP0-APP15, COM segments) and PNG (all non-critical chunks) stripped at the byte level; Canvas fallback for WebP/BMP/GIF
- **Magic-byte format detection** — file format detected from actual content bytes, not the spoofable file extension
- **Non-image metadata warnings** — PDFs, Office docs, video, audio, and SVGs flagged with a warning that metadata may be retained
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
- **Rooms** — list/kill individual Signal Rooms, purge all, connection stats
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

### Server-Side
- **Content-Security-Policy with nonces** — per-request cryptographic nonces block injected scripts
- **Cross-origin isolation** — COOP, COEP, CORP headers on tool pages prevent cross-origin attacks
- **Cache-Control no-store** — tool pages and encrypted API responses never cached by browser or proxy
- **Security headers** — X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy no-referrer, X-DNS-Prefetch-Control off, HSTS in production
- **Expanded Permissions-Policy** — camera, microphone, geolocation, display-capture, and all hardware APIs disabled
- **Server fingerprint removal** — X-Powered-By disabled, generic error responses
- **Login credential type validation** — non-string inputs rejected with timing-safe dummy hash (prevents scrypt crash and username enumeration)
- **Login rate limiting** — 5 attempts per IP per minute
- **File upload rate limiting** — 20 uploads per IP per hour
- **CSRF origin checking** — URL-parsed host comparison on all state-changing requests
- **WebSocket origin validation** — only allowed origins can connect
- **scrypt password hashing** with random salt (env var password hashed at startup)
- **Timing-safe comparison** (prevents timing attacks)
- **Generic session cookie name** — `__session` instead of default `connect.sid` (prevents Express fingerprinting)
- **httpOnly, sameSite lax, secure cookies**
- **Rate limit Map cleanup** — periodic pruning prevents memory exhaustion via IP rotation
- **Connection limits** — per-IP (10), global (500), per-room (50), max rooms (1000)
- **Rate limiting** — 10 WebSocket messages/sec per connection
- **Allowlist-based env var exposure** in system info API
- **ID format validation** — UUID regex on all :id route params

### Client-Side Anti-Forensics
- **Key fragment stripping** — decryption keys removed from URL bar and browser history via `history.replaceState` immediately after extraction
- **Clipboard auto-clear** — copied URLs and content automatically wiped from clipboard after 30 seconds
- **Memory wiping** — ArrayBuffers zeroed after use, crypto key references nulled
- **Page lifecycle cleanup** — all sensitive data (textarea content, decrypted text, file buffers, WebSocket connections) wiped on page unload
- **Image metadata stripping** — byte-level JPEG/PNG stripping (APP segments, non-critical chunks), Canvas fallback for other formats, magic-byte detection (not extension-based)
- **Honest threat model disclaimer** — each tool page includes a "Limitations" section explaining what client-side encryption cannot protect against
- **Service worker prevention** — existing service workers unregistered on page load, `worker-src 'none'` in CSP blocks registration
- **Storage lockdown** — localStorage, sessionStorage, and IndexedDB cleared on tool page load
- **Crypto self-tests** — Web Crypto API and CSPRNG availability verified on page load

### Runtime Integrity Hardening
- **Bootstrap self-check** — `Function.prototype.toString` is called on itself to verify it has not been replaced before any other integrity checks run; `Function.prototype.call` is verified the same way
- **Frozen built-in references** — all critical browser APIs (`crypto.subtle`, `fetch`, `btoa`/`atob`, `TextEncoder`/`TextDecoder`, `WebSocket`, `URL.createObjectURL`) captured at script start and used via frozen references, preventing monkey-patching by malicious extensions or injected scripts
- **Native function integrity checks** — `Function.prototype.toString` verification on all security-critical functions including `Object.freeze`; page refuses to operate if any API has been tampered with
- **Frozen crypto objects** — `crypto` and `crypto.subtle` are frozen after integrity checks, preventing post-load reassignment of crypto methods
- **Secure context enforcement** — `isSecureContext` check blocks execution on non-HTTPS connections (localhost allowed for development)
- **Prototype pollution prevention** — `Object.freeze(Object.prototype)` and `Object.freeze(Array.prototype)` at page load blocks prototype pollution attacks
- **Strict mode** — all tool page scripts run in strict mode; prototype modification attempts throw `TypeError` instead of silently failing
- **String avoidance** — decrypt functions return raw `Uint8Array` instead of strings; callers decode and wipe the buffer in tight synchronous blocks, minimizing plaintext string copies lingering in the JavaScript heap
- **DOM overwrite before clear** — sensitive DOM elements are overwritten with random printable ASCII data before clearing, making simple memory dump analysis harder
- **Tight decryption windows** — decrypt, render to DOM, and zero the buffer all happen in the shortest possible synchronous code path with no intervening async operations
- **Blob URL lifecycle tracking** — active blob URLs are tracked and revoked both on timer (500ms) and on page unload; no orphaned blob URLs can persist

## API

All `/api/*` endpoints require authentication except `/api/drop`, `/api/file`, and `/api/chat` (public).

### Public (no auth)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/drop` | Create encrypted drop (`{ encrypted, iv, burn?, expiry? }`) |
| `GET` | `/api/drop/:id` | Retrieve encrypted drop (deletes if burn-after-read) |
| `POST` | `/api/file` | Create encrypted file (`{ encrypted, iv, encryptedMeta, metaIv, burn?, expiry? }`) |
| `GET` | `/api/file/:id` | Retrieve encrypted file (deletes if burn-after-download) |
| `POST` | `/api/chat/room` | Register a chat room (`{ roomId, accessTokenHash, inviteTokenHashes }`) |

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
| `GET` | `/api/chat/rooms` | List all registered rooms |
| `DELETE` | `/api/chat/rooms/:id` | Kill a room (disconnect all participants) |
| `POST` | `/api/chat/rooms/purge` | Purge all rooms |
| `GET` | `/api/system` | System info + env vars (allowlisted) |
| `GET` | `/api/logs` | Request log (last 200) |

## Testing

```bash
npm test           # run all 73 tests
npm run test:watch # watch mode (re-runs on file changes)
```

Tests cover authentication (5), Dead Drop CRUD (5), File Drop (4), Signal Room (9), security headers (5), public pages (4), rate limiting (1), and adversarial tests: drop abuse (7), file abuse (5), room registration abuse (6), WebSocket abuse (7), auth abuse (7), error handling (4). Plus a login bug fix found by adversarial testing. Uses vitest + supertest.

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
tests/
  server.test.js         # Test suite (73 tests)
```

## Deploying to Render

1. Push to GitHub
2. Create a Web Service, connect the repo
3. Set `ADMIN_PASSWORD`, `SESSION_SECRET` in Environment
4. Build command: `npm install`
5. Start command: `npm start`

No database required. Auto-deploys on push.
