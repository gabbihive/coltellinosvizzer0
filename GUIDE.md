# coltellinosvizzer0 — The Complete Guide

This guide explains every part of this project from the ground up. No prior experience with these tools is assumed — just basic familiarity with JavaScript and the command line.

---

## Table of Contents

1. [What Is This Project?](#what-is-this-project)
2. [The Technology Stack](#the-technology-stack)
3. [Project Structure](#project-structure)
4. [Getting It Running](#getting-it-running)
5. [How the Server Works](#how-the-server-works)
6. [Authentication & Security](#authentication--security)
7. [Dead Drop — Zero-Knowledge Paste Bin](#dead-drop--zero-knowledge-paste-bin)
8. [Signal Room — Zero-Knowledge Encrypted Chat](#signal-room--zero-knowledge-encrypted-chat)
9. [File Drop — Zero-Knowledge Encrypted File Sharing](#file-drop--zero-knowledge-encrypted-file-sharing)
10. [The Admin Panel](#the-admin-panel)
11. [The API](#the-api)
12. [Deploying to the Internet](#deploying-to-the-internet)
13. [Common Tasks](#common-tasks)
14. [Troubleshooting](#troubleshooting)

---

## What Is This Project?

This is a **self-hosted tools platform** — a web server that hosts privacy-focused utilities and provides an admin panel to manage everything. Currently it includes:

- **Dead Drop** — an anonymous, zero-knowledge encrypted paste bin
- **Signal Room** — an anonymous, zero-knowledge encrypted ephemeral chat
- **File Drop** — an anonymous, zero-knowledge encrypted file sharing service with metadata stripping
- **Admin Panel** — a browser-based control panel for managing drops, files, and settings

Think of it as a private toolbox running on the internet. The tools are public (anyone with the link can use them), but the admin panel is locked behind authentication. Everything is in-memory — no database, no disk storage, nothing to subpoena or leak.

---

## The Technology Stack

| Technology | What It Is | What It Does Here |
|---|---|---|
| **Node.js** | A JavaScript runtime | Runs the server code (JavaScript outside a browser) |
| **Express** | A web framework for Node.js | Handles HTTP requests, routing, and middleware |
| **ws** | A WebSocket library | Powers real-time chat relay for Signal Room |
| **Web Crypto API** | Browser-native cryptography | Encrypts/decrypts content entirely in the user's browser |
| **dotenv** | An env var loader | Reads the `.env` file so you can configure the app without changing code |
| **express-session** | Session middleware | Keeps the admin logged in between page loads using browser cookies |
| **nodemon** | A development tool | Auto-restarts the server when you save a file (dev only) |
| **vitest** | A test framework | Runs the test suite (dev only) |
| **supertest** | HTTP test library | Makes HTTP requests to Express in tests without starting a server (dev only) |

### What Are Environment Variables?

Environment variables are settings that live *outside* your code. They're used for values that:
- Change between environments (your laptop vs. a production server)
- Are secret (passwords, API keys)

You define them in a `.env` file locally. In production, you set them in your hosting provider's dashboard. The code reads them with `process.env.VARIABLE_NAME`.

---

## Project Structure

```
Proj1/
├── .env                    # Your local config (secret — never commit this)
├── .env.example            # Template showing what .env should look like
├── .gitignore              # Tells Git which files to ignore
├── package.json            # Project metadata + dependency list
├── render.yaml             # Deployment config for Render.com
│
├── tests/
│   └── server.test.js      # Test suite (73 tests)
│
└── src/
    ├── server.js           # The main application — everything starts here
    └── public/
        ├── landing.html    # Tools index page (public, served at /)
        ├── drop.html       # Dead Drop UI (/drop)
        ├── chat.html       # Signal Room UI (/chat)
        ├── file.html       # File Drop UI (/file)
        ├── index.html      # Admin panel (/panel)
        └── login.html      # Login page
```

### What Each File Does

**`src/server.js`** — The main application file. Sets up Express, defines all routes, handles authentication, serves tools and the admin panel, runs the WebSocket relay for Signal Room, and starts listening for requests. All data is stored in memory (Maps and arrays).

**`src/public/landing.html`** — The public tools index. Lists available tools with a subtle admin link in the footer.

**`src/public/drop.html`** — The Dead Drop interface. Handles both composing (encrypting and submitting) and reading (fetching and decrypting) drops. All cryptography happens in this file using the Web Crypto API.

**`src/public/chat.html`** — The Signal Room interface. Creates rooms, connects via WebSocket, encrypts/decrypts messages client-side. All cryptography happens in this file.

**`src/public/file.html`** — The File Drop interface. Handles file selection, byte-level JPEG/PNG metadata stripping (with Canvas fallback for other image formats), non-image metadata warnings, encryption of both file content and metadata (filename + type), and decrypted file download. All cryptography happens in this file.

**`src/public/index.html`** — The admin panel. A tabbed SPA with Dashboard, Drops, Files, Rooms, and Settings tabs.

**`src/public/login.html`** — The admin login page. Submits credentials to `/auth/login` and redirects to `/panel` on success.

**`render.yaml`** — Tells Render.com how to build and run the app.

---

## Getting It Running

### Prerequisites

1. **Node.js** (version 18 or higher) — [nodejs.org](https://nodejs.org)

That's it. No database needed.

### Step-by-Step Setup

```bash
# 1. Install dependencies
npm install

# 2. Create your config file
cp .env.example .env
```

Edit `.env`:
```
PORT=3000
SESSION_SECRET="any-random-string-here-make-it-long"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD="your-password-here"
```

```bash
# 3. Start the server
npm run dev
```

Open **http://localhost:3000** — you'll see the tools index. Admin panel is at `/panel`.

---

## How the Server Works

### The Request Lifecycle

When you visit `http://localhost:3000/api/status`:

```
Browser sends GET /api/status
        │
        ▼
┌─ Express receives the request ─────────────────────┐
│                                                     │
│  1. express.json() — parses JSON request bodies     │
│  2. Security headers — X-Frame-Options, etc.        │
│  3. CSRF origin check — blocks cross-origin POSTs   │
│  4. session() — loads your session from the cookie  │
│  5. Request logger — records this request           │
│  6. requireAuth — checks if you're logged in        │
│  7. Route handler — runs the code for this endpoint │
│                                                     │
└─────────────────────────────────────────────────────┘
        │
        ▼
Server reads from in-memory Map/data
        │
        ▼
Server sends JSON response
```

### Route Organization

Routes are split into three groups:

1. **Public routes** (no auth): `/`, `/drop`, `/drop/:id`, `/chat`, `/chat/:id`, `/file`, `/file/:id`, `/api/drop`, `/api/drop/:id`, `/api/file`, `/api/file/:id`, `/auth/*`, `/login.html`
2. **Auth-protected routes**: everything else — admin panel, API endpoints
3. **Privacy-excluded routes**: drop, chat, and file routes are excluded from request logging

### Middleware

Middleware are functions that run *before* your route handler. The order matters:
1. Body parsers (so handlers can read `req.body`)
2. Security headers (X-Frame-Options, HSTS, etc.)
3. CSRF origin validation (blocks cross-origin state changes)
4. Session middleware (so auth can check `req.session`)
5. Request logger (records the request, skips drop/chat/file routes)
6. Auth middleware blocks unauthenticated access to protected routes

### In-Memory Architecture

All data lives in JavaScript Maps and arrays:
- **Pastes** — `Map<id, {encrypted, iv, burnAfterRead, expiresAt, createdAt}>`, max 10,000 entries
- **Files** — `Map<id, {encrypted, iv, encryptedMeta, metaIv, burnAfterRead, expiresAt, createdAt, size}>`, max 1,000 entries, 500 MB total
- **Chat rooms** — `Map<roomId, Set<WebSocket>>`, rooms auto-deleted when empty
- **Registered rooms** — `Map<roomId, {accessTokenHash, invites, createdAt, expiresAt}>`, max 1,000 rooms, 24h lifetime
- **Request log** — ring buffer array, last 200 entries
- **Password override** — single string, resets on restart

Everything is lost on server restart. This is a feature — it maximizes privacy.

---

## Authentication & Security

### How Login Works

```
1. Visit /panel → requireAuth redirects to /login.html
2. Enter username + password → POST /auth/login
3. Rate limit check (5 attempts/min per IP)
4. Server verifies password (always via scrypt hash)
5. Session created → cookie sent to browser
6. All future requests include cookie → auth passes
```

### Password Verification

The `ADMIN_PASSWORD` env var is hashed with scrypt at startup. All comparisons are against hashes — the plaintext env var is never compared directly. Password changes via the UI create an in-memory override (resets on restart, env var becomes recovery password).

### Security Features

**Server-side:**
- **Content-Security-Policy with nonces** — per-request cryptographic nonces block injected scripts; `worker-src 'none'` blocks service worker registration; `form-action 'none'` blocks form hijacking
- **Cross-origin isolation** — COOP `same-origin`, COEP `require-corp`, CORP `same-origin` on tool pages
- **Cache-Control no-store** — tool pages and encrypted API responses never cached
- **Security headers** — X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy no-referrer, X-DNS-Prefetch-Control off, X-Permitted-Cross-Domain-Policies none, HSTS in production
- **Expanded Permissions-Policy** — camera, microphone, geolocation, display-capture, and all hardware APIs disabled
- **Server fingerprint removal** — X-Powered-By disabled, generic error responses
- **Login credential type validation** — non-string inputs rejected with timing-safe dummy hash (prevents crash and username enumeration)
- **Login rate limiting** — 5 attempts per IP per minute
- **File upload rate limiting** — 20 uploads per IP per hour
- **CSRF origin checking** — URL-parsed host comparison (not substring) on state-changing requests
- **WebSocket origin validation** — only allowed origins can establish connections
- **scrypt password hashing** with random salt
- **Timing-safe comparison** (prevents timing attacks)
- **Generic session cookie name** (`__session`) — prevents Express/connect.sid fingerprinting
- **httpOnly cookies** (JavaScript can't read them)
- **sameSite: lax** (prevents most CSRF)
- **secure: true in production** (HTTPS only)
- **trust proxy** set for Render's reverse proxy
- **Allowlist-based env var exposure** — system info API only shows safe variables
- **Connection limits** — per-IP, global, per-room, max rooms
- **Message rate limiting** — 10 WebSocket messages/sec per connection
- **8-hour session expiry**
- **Max password length** (128 chars) to prevent CPU-bound DoS via scrypt
- **Rate limit Map cleanup** — periodic pruning every 5 minutes prevents memory exhaustion from IP rotation attacks
- **WebSocket origin allowlist from env** — no hardcoded production URLs in source code
- **ID format validation** — UUID regex on all :id route params

**Client-side anti-forensics (all tool pages):**
- **Key fragment stripping** — decryption keys removed from URL bar and browser history via `history.replaceState` immediately after extraction
- **Clipboard auto-clear** — copied URLs and content automatically wiped from clipboard after 30 seconds
- **Memory wiping** — ArrayBuffers zeroed after use, crypto key references nulled on page unload
- **Page lifecycle cleanup** — sensitive data wiped on `pagehide` (tab close / navigation away)
- **Image metadata stripping** — byte-level JPEG/PNG stripping (APP segments, non-critical chunks) with Canvas fallback; magic-byte format detection; non-image metadata warnings
- **Service worker prevention** — existing service workers unregistered on load, CSP blocks new registration
- **Storage lockdown** — localStorage, sessionStorage, and IndexedDB cleared on tool page load
- **Crypto self-tests** — Web Crypto API and CSPRNG availability verified on page load

**Runtime integrity hardening (all tool pages):**

These defenses protect against browser extensions, injected scripts, or other code running in the same page context that attempts to intercept sensitive data by monkey-patching browser APIs.

- **Bootstrap self-check** — Before any other integrity check, `Function.prototype.toString` is called on *itself* to verify it returns `[native code]`. Same for `Function.prototype.call`. This catches extensions or injected scripts that replace `toString` with a wrapper (which would make all subsequent `_assertNative` checks pass regardless). Not bulletproof — a targeted attacker can special-case the self-check — but it raises the bar from trivial bypass to targeted effort.
- **Frozen built-in references** — All critical browser APIs (`crypto.subtle.*`, `fetch`, `btoa`/`atob`, `TextEncoder`, `TextDecoder`, `Uint8Array`, `WebSocket`, `URL.createObjectURL`/`revokeObjectURL`, `JSON.parse`/`stringify`, `setTimeout`, `history.replaceState`) are captured into `const` variables at the very first line of the script, before any other code could tamper with them. All subsequent code uses these frozen references exclusively.
- **Native function integrity checks** — After capturing references, the script verifies each critical function via `Function.prototype.toString.call(fn)` to confirm it contains `[native code]`, including `Object.freeze` itself. If any function has been replaced by a JavaScript wrapper (indicating monkey-patching), the page displays an error and refuses to operate.
- **Frozen crypto objects** — `crypto` and `crypto.subtle` are frozen after integrity checks, preventing later-loading scripts (injected ads, analytics, compromised extensions) from replacing crypto methods after the page's checks have passed.
- **Secure context enforcement** — `window.isSecureContext` is checked before any crypto operations. This blocks the page from running over plain HTTP (except localhost for development), preventing man-in-the-middle scenarios where crypto APIs might be unavailable or compromised.
- **Prototype pollution prevention** — `Object.freeze(Object.prototype)` and `Object.freeze(Array.prototype)` are called at page load. This prevents prototype pollution attacks where an attacker adds malicious properties or methods to `Object.prototype` that would be inherited by all objects (a common attack vector in JavaScript).
- **Strict mode** — All tool page scripts run under `'use strict'`, which means attempts to modify frozen prototypes throw `TypeError` instead of silently failing, making attacks more detectable.
- **String avoidance for sensitive data** — JavaScript strings are immutable and garbage-collected unpredictably — once a string exists, you cannot wipe it from memory. To minimize plaintext string copies in the JS heap, decrypt functions return raw `Uint8Array` buffers. The caller decodes to string and assigns to the DOM in the tightest possible synchronous block, then immediately zeros the buffer. This doesn't eliminate the string (the DOM still holds it), but it removes the intermediate buffer copy.
- **DOM overwrite before clear** — When sensitive content is removed from the DOM (on page unload, or when clearing elements), `secureClearElement()` first overwrites the element's text with random printable ASCII characters, then clears it. This means the browser's internal text buffer is overwritten before deallocation, making simple memory dump analysis harder.
- **Tight decryption windows** — The sequence of decrypt → render to DOM → zero the source buffer happens in the shortest possible synchronous code path with no intervening `await` or event loop yields. This minimizes the time window during which both the buffer and the DOM string exist simultaneously.
- **Blob URL lifecycle tracking** — In File Drop, active blob URLs are tracked in a module-level variable and revoked both on a 500ms timer (after download starts) and on page unload. No orphaned blob URLs can persist in memory.

**What these checks do NOT protect against:**

All of the above run in the same JavaScript environment they are trying to verify. A state-level adversary who has compromised the browser itself (modified browser binary, kernel-level keylogger, zero-day exploit) can intercept at a level below what JavaScript can detect. These checks are defense-in-depth: they catch automated tools, naive extensions, injected scripts, and casual tampering. They raise the bar. They do not create an impenetrable barrier. Each tool page includes an honest "Limitations" disclaimer explaining this to users.

For high-risk situations, the actual defenses are operational: use a known-clean device, boot from a live USB, use Tor Browser with no extensions, and verify the page via a second independent device.

---

## Dead Drop — Zero-Knowledge Paste Bin

Dead Drop is designed for sharing sensitive text where even the server operator cannot read the content.

### How It Works

```
┌─ Your Browser ─────────────────────────────────────┐
│                                                     │
│  1. Generate random 256-bit AES key                 │
│  2. Encrypt text with AES-256-GCM + random IV       │
│  3. Send ONLY ciphertext + IV to server             │
│                                                     │
└────────────────────┬────────────────────────────────┘
                     │ POST /api/drop { encrypted, iv }
                     ▼
┌─ Server ───────────────────────────────────────────┐
│                                                     │
│  Stores ciphertext + IV in memory                   │
│  Returns paste ID                                   │
│  NEVER sees the key or plaintext                    │
│                                                     │
└────────────────────┬────────────────────────────────┘
                     │
                     ▼
   URL: /drop/abc123#<base64url-encoded-key>
                      ─────────┬──────────
                               │
              The # fragment is NEVER sent to the server
              Only the link holder can decrypt
```

### Key Design Decisions

- **In-memory only**: Drops are never written to disk. They are lost on server restart.
- **Key in URL fragment**: Browsers never transmit the `#fragment` portion of a URL to the server.
- **No logging on drop routes**: No IPs, timestamps, or user agents are recorded.
- **Burn after reading**: The in-memory entry is deleted immediately after retrieval.
- **Auto-expiry**: Expired drops are cleaned up every 60 seconds.
- **256 KB limit**: Prevents abuse.
- **IV validation**: The IV field is type-checked and length-limited.

---

## Signal Room — Zero-Knowledge Encrypted Chat

Signal Room is an ephemeral chat where the server acts as a dumb relay of ciphertext.

### How It Works

```
┌─ Browser A ────────────────────────────────────────┐
│                                                     │
│  1. Create room → random ID + 256-bit AES key       │
│  2. Share URL: /chat/<roomId>#<key>                  │
│  3. Connect WebSocket to /chat/<roomId>              │
│  4. Type message → encrypt with AES-256-GCM → send  │
│                                                     │
└────────────────────┬────────────────────────────────┘
                     │ WebSocket: { type:"msg", data:"<ciphertext>", iv:"<iv>" }
                     ▼
┌─ Server ───────────────────────────────────────────┐
│                                                     │
│  Receives opaque JSON blob                          │
│  Broadcasts to all other peers in the room          │
│  Stores NOTHING — not even temporarily              │
│  Cannot decrypt — never has the key                 │
│                                                     │
└────────────────────┬────────────────────────────────┘
                     │
                     ▼
┌─ Browser B ────────────────────────────────────────┐
│                                                     │
│  Receives ciphertext → decrypt with key from URL    │
│  Display plaintext message                          │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Room Access Control

Signal Room uses a multi-layer access control system:

1. **Room registration** — rooms must be registered via `POST /api/chat/room` before anyone can connect. This sets up the access token hash and invite token hashes.
2. **Access tokens** — HKDF-derived from the encryption key. Proves the connector possesses the key without revealing it. SHA-256 hashed and verified with `crypto.timingSafeEqual`.
3. **Invite tokens** — each token grants one concurrent connection. Tokens are released on disconnect so users can reconnect after network drops. For pre-defined rooms, invite URLs contain the token. For rendezvous rooms, tokens are deterministically derived from the passphrase.

### Deterministic Rendezvous

For situations where sharing URLs is impractical (e.g., pre-arranged meetups), members can derive the same room from a shared passphrase:

1. Passphrase + sequence number → PBKDF2 (600,000 iterations) → master key
2. Master key → HKDF → room ID, encryption key, and invite tokens
3. All members with the same passphrase + sequence number arrive at the same encrypted room
4. If a room is compromised, increment the sequence number to get a fresh room

### Key Design Decisions

- **No storage at all**: Messages exist only in transit. The server never buffers them.
- **Forward secrecy**: Symmetric key ratcheting via HKDF chain derivation. Each message uses a new derived key (`key_{n+1} = HKDF(key_n, room-scoped salt)`). Old keys are wiped after a 10-message window. If the current key is compromised, past messages remain protected. Generation counter (`g`) transmitted in cleartext alongside encrypted payload. Max gap capped at 100 to prevent computation DoS.
- **Rooms auto-destroy**: When the last participant disconnects, the room is deleted.
- **24-hour room lifetime**: Server-enforced maximum, with client countdown display.
- **2-minute inactivity timeout**: Warning at 90 seconds, auto-disconnect and wipe at 120 seconds.
- **Anonymous peer IDs**: 4-hex-char random IDs, no usernames or accounts.
- **Callsign system**: Optional pre-agreed aliases encrypted in the message payload.
- **Participant verification**: SHA-256 safety numbers derived from the encryption key for out-of-band verification.
- **Message padding**: Messages padded to fixed bucket sizes (128–32768 bytes) to prevent traffic analysis.
- **Rate limiting**: 10 messages/second per connection.
- **Connection limits**: 50 per room, 10 per IP, 500 globally, 1000 max rooms.
- **Room creation rate limiting**: 10 rooms per IP per hour.
- **Origin validation**: Only allowed origins can connect via WebSocket.

---

## File Drop — Zero-Knowledge Encrypted File Sharing

File Drop is designed for sharing files where even the server operator cannot see the content, filename, or file type.

### How It Works

```
┌─ Your Browser ─────────────────────────────────────┐
│                                                     │
│  1. Select file                                     │
│  2. Strip image metadata (byte-level JPEG/PNG,       │
│  │  Canvas fallback for other formats)               │
│  3. Generate random 256-bit AES key                 │
│  4. Encrypt file bytes with AES-256-GCM + random IV │
│  5. Encrypt filename + type separately              │
│  6. Send ONLY ciphertext to server                  │
│                                                     │
└────────────────────┬────────────────────────────────┘
                     │ POST /api/file { encrypted, iv, encryptedMeta, metaIv }
                     ▼
┌─ Server ───────────────────────────────────────────┐
│                                                     │
│  Stores ciphertext in memory                        │
│  Returns file ID                                    │
│  NEVER sees the key, filename, type, or content     │
│                                                     │
└────────────────────┬────────────────────────────────┘
                     │
                     ▼
   URL: /file/abc123#<base64url-encoded-key>
                      ─────────┬──────────
                               │
              The # fragment is NEVER sent to the server
              Only the link holder can decrypt
```

### Key Design Decisions

- **In-memory only**: Files are never written to disk. They are lost on server restart.
- **Key in URL fragment**: Browsers never transmit the `#fragment` portion of a URL to the server.
- **Encrypted metadata**: The filename and MIME type are encrypted separately — the server has no idea what file was uploaded.
- **Image metadata stripping**: JPEG images are stripped at the byte level (APP0-APP15 and COM segments removed). PNG images are stripped at the byte level (only critical chunks IHDR, PLTE, IDAT, IEND, tRNS kept). Format is detected from magic bytes, not file extension. WebP, BMP, and GIF fall back to Canvas re-render. Non-image files (PDFs, DOCX, video, audio, SVG) display a metadata warning.
- **No logging on file routes**: No IPs, timestamps, or user agents are recorded.
- **Burn after download**: The in-memory entry is deleted immediately after one retrieval.
- **Auto-expiry**: Expired files are cleaned up every 60 seconds.
- **10 MB limit per file, 500 MB total**: Prevents abuse of in-memory storage.
- **Upload rate limiting**: 20 uploads per IP per hour.
- **IV validation**: Both content and metadata IVs are type-checked and length-limited.
- **Metadata size cap**: Encrypted metadata capped at 4 KB to prevent abuse.

---

## The Admin Panel

The admin panel at `/panel` is a single-page application with five tabs. All pages use a dark monospace theme.

### Dashboard

- Status cards: uptime, memory, active drops, active files, chat rooms, chat peers
- Live request log (auto-refreshes every 5 seconds)
- Drop and chat routes are excluded from the log for privacy

### Drops

- Stats: total, active, expired, burn-on-read counts
- Table of all drops: ID, status, type, expiry countdown, creation date
- Actions: delete individual drops, purge all expired
- Note: admin cannot read drop contents (zero-knowledge)

### Files

- Stats: total, active, expired, burn-on-download counts, total storage
- Table of all files: ID, status, type, size, expiry countdown, creation date
- Actions: delete individual files, purge all expired
- Note: admin cannot read file contents, names, or types (zero-knowledge)

### Rooms

- Stats: registered rooms, active rooms, connected peers
- Table of all rooms: room ID, status (active/expired), connected peers, invites remaining, expiry countdown, creation date
- Actions: kill individual rooms (disconnects all participants), purge all rooms
- Note: admin cannot read message contents (zero-knowledge)

### Settings

- Change admin password (resets on restart)
- View environment variables (allowlisted, sensitive values masked)
- System information (Node version, OS, memory)

---

## The API

Every endpoint returns JSON.

### Public Endpoints (no auth)

| Method | URL | Body | Description |
|--------|-----|------|-------------|
| `POST` | `/api/drop` | `{ encrypted, iv, burn?, expiry? }` | Create a drop |
| `GET` | `/api/drop/:id` | — | Retrieve a drop (burns if flagged) |
| `POST` | `/api/file` | `{ encrypted, iv, encryptedMeta, metaIv, burn?, expiry? }` | Create a file drop |
| `GET` | `/api/file/:id` | — | Retrieve a file (burns if flagged) |
| `POST` | `/api/chat/room` | `{ roomId, accessTokenHash, inviteTokenHashes }` | Register a chat room |
| `POST` | `/auth/login` | `{ username, password }` | Log in (rate limited) |
| `POST` | `/auth/logout` | — | Log out |
| `GET` | `/auth/check` | — | Check auth status |
| `POST` | `/auth/change-password` | `{ currentPassword, newPassword }` | Change password (requires auth) |

### Admin Endpoints (auth required)

| Method | URL | Description |
|--------|-----|-------------|
| `GET` | `/api/status` | Server health |
| `GET` | `/api/drops` | List drops (metadata only) |
| `GET` | `/api/drops/stats` | Drop statistics |
| `DELETE` | `/api/drops/:id` | Delete a drop |
| `POST` | `/api/drops/purge-expired` | Purge expired drops |
| `GET` | `/api/files` | List files (metadata only) |
| `GET` | `/api/files/stats` | File statistics |
| `DELETE` | `/api/files/:id` | Delete a file |
| `POST` | `/api/files/purge-expired` | Purge expired files |
| `GET` | `/api/chat/stats` | Chat room/peer counts |
| `GET` | `/api/chat/rooms` | List all registered rooms |
| `DELETE` | `/api/chat/rooms/:id` | Kill a room (disconnect all) |
| `POST` | `/api/chat/rooms/purge` | Purge all rooms |
| `GET` | `/api/system` | System info + env vars (allowlisted) |
| `GET` | `/api/logs` | Request log (last 200) |

### HTTP Status Codes

| Code | Meaning | When You'll See It |
|------|---------|-------------------|
| `200` | OK | Successful read or update |
| `201` | Created | New drop created |
| `204` | No Content | Successful delete |
| `400` | Bad Request | Missing required field |
| `401` | Unauthorized | Not logged in or wrong password |
| `403` | Forbidden | CSRF origin check failed |
| `404` | Not Found | Resource doesn't exist or expired |
| `413` | Payload Too Large | Drop exceeds 256 KB |
| `429` | Too Many Requests | Login rate limit exceeded |
| `503` | Service Unavailable | Server at paste capacity |

---

## Deploying to the Internet

### Render Deployment

The app is deployed on Render at `https://server-express-u3tu.onrender.com`.

The `render.yaml` file configures:
```yaml
buildCommand: npm install
startCommand: npm start
```

### Environment Variables on Render

| Variable | Value |
|----------|-------|
| `ADMIN_PASSWORD` | Admin login password |
| `SESSION_SECRET` | Random string for session signing |
| `NODE_ENV` | `production` (set in render.yaml) |

No database required. Auto-deploys on push to `main`.

---

## Testing

The project has a test suite with 73 tests covering happy paths and adversarial abuse scenarios.

### Running Tests

```bash
npm test           # single run — all tests
npm run test:watch # watch mode — re-runs when you save a file
```

### What the Tests Cover

| Category | Tests | What They Verify |
|----------|-------|-----------------|
| Authentication | 5 | Login, logout, password change (12-char minimum), rate limiting, CSRF blocking |
| Dead Drop | 5 | Create, retrieve, burn-after-read, size limits, admin delete |
| File Drop | 4 | Create, retrieve, burn-after-download, admin delete |
| Signal Room | 9 | Room registration, WebSocket connect with correct/wrong tokens, reconnection after disconnect, two-peer message relay, forward secrecy generation counter relay, admin kill |
| Security | 5 | CSP nonces, security headers, cross-origin isolation, cache headers, CSRF |
| Public pages | 4 | Landing page, tool pages without auth, admin auth gate, limitations disclaimer present |
| Drop abuse | 7 | Empty body, non-string fields, oversized IV, empty encrypted, invalid expiry fallback, non-existent UUID, path traversal |
| File abuse | 5 | Missing fields, non-string types, oversized IV/metaIv, oversized metadata, oversized file |
| Room registration abuse | 6 | Missing fields, XSS in room ID, short/long room ID, invalid access token hash, empty/oversized invite arrays, invalid invite hash format |
| WebSocket abuse | 7 | Unregistered room, missing tokens, invalid path, missing origin, oversized message (connection kill), malformed JSON/wrong type/missing fields, concurrent invite token |
| Auth abuse | 7 | Empty body, non-string credentials, short password, oversized password (DoS prevention), wrong current password, invalid admin drop/file IDs, non-existent resource 404 |
| Error handling | 4 | Authenticated 404 (JSON), unauthenticated API route (401 not 404), unauthenticated page route (302 not 404), malformed JSON body |
| Rate limiting | 1 | Login attempts capped at 5/min |

### How the Tests Work

The test suite imports `server.js` without starting the HTTP listener (the export detects `require.main !== module`). Tests use `supertest` to make HTTP requests directly to the Express app, and real `WebSocket` connections for Signal Room tests. The test server listens on a random port to avoid conflicts.

The WebSocket tests exercise the full token flow: generate tokens → hash as raw bytes → register room via API → connect WebSocket with access + invite tokens → verify `init` message. This end-to-end coverage caught the hash encoding mismatch bug (server was hashing hex strings instead of raw bytes).

### When to Run Tests

- Before pushing changes to `src/server.js`
- After modifying authentication, crypto token flows, or API routes
- After changing CSP or security headers

---

## Common Tasks

### Add a New Tool

1. Create the HTML file in `src/public/` (follow the dark monospace theme)
2. Add public routes in `src/server.js` before the `requireAuth` middleware
3. Add a card to `src/public/landing.html` linking to the new tool
4. Exclude routes from request logging if the tool handles sensitive data

### Reset a Forgotten Admin Password

Restart the server. The in-memory password override is cleared, and the `ADMIN_PASSWORD` env var works again.

### Purge Expired Drops

Via admin panel: Drops tab > "Purge Expired" button.

Via API:
```bash
curl -b cookies.txt -X POST http://localhost:3000/api/drops/purge-expired
```

---

## Troubleshooting

### "ADMIN_PASSWORD env var is required"
Set `ADMIN_PASSWORD` in `.env`.

### "WARNING: SESSION_SECRET not set"
Set `SESSION_SECRET` in `.env`. Without it, sessions are lost on restart.

### Login doesn't work on Render
Ensure `trust proxy` is set (it is). Check that `NODE_ENV=production` is set so secure cookies work over HTTPS.

### Drops show "Not found" immediately
The drop expired, was burned, or the server restarted (all drops are in-memory).

### The admin panel shows "Loading..."
Check browser console (F12). Likely a 401 (session expired).

### Chat says "disconnected"
The WebSocket connection was lost. This happens on server restart or network issues. Reconnecting with the same invite token works — tokens are released on disconnect. For rendezvous rooms, re-entering the same passphrase and sequence number will reconnect you.
