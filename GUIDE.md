# server-express — The Complete Guide

This guide explains every part of this project from the ground up. No prior experience with these tools is assumed — just basic familiarity with JavaScript and the command line.

---

## Table of Contents

1. [What Is This Project?](#what-is-this-project)
2. [The Technology Stack](#the-technology-stack)
3. [Project Structure](#project-structure)
4. [Getting It Running](#getting-it-running)
5. [How the Server Works](#how-the-server-works)
6. [The Database](#the-database)
7. [Authentication & Security](#authentication--security)
8. [Dead Drop — Zero-Knowledge Paste Bin](#dead-drop--zero-knowledge-paste-bin)
9. [The Admin Panel](#the-admin-panel)
10. [The API](#the-api)
11. [Deploying to the Internet](#deploying-to-the-internet)
12. [Common Tasks](#common-tasks)
13. [Troubleshooting](#troubleshooting)

---

## What Is This Project?

This is a **self-hosted tools platform** — a web server that hosts privacy-focused utilities and provides an admin panel to manage everything. Currently it includes:

- **Dead Drop** — an anonymous, zero-knowledge encrypted paste bin
- **Admin Panel** — a browser-based control panel for managing drops, users, database, and settings

Think of it as a private toolbox running on the internet. The tools are public (anyone with the link can use Dead Drop), but the admin panel is locked behind authentication.

---

## The Technology Stack

| Technology | What It Is | What It Does Here |
|---|---|---|
| **Node.js** | A JavaScript runtime | Runs the server code (JavaScript outside a browser) |
| **Express** | A web framework for Node.js | Handles HTTP requests, routing, and middleware |
| **PostgreSQL** | A relational database | Stores users, settings, and encrypted paste data permanently |
| **Prisma** | An ORM (Object-Relational Mapper) | Lets you work with the database using JavaScript instead of writing raw SQL |
| **Web Crypto API** | Browser-native cryptography | Encrypts/decrypts paste content entirely in the user's browser |
| **dotenv** | An env var loader | Reads the `.env` file so you can configure the app without changing code |
| **express-session** | Session middleware | Keeps the admin logged in between page loads using browser cookies |
| **nodemon** | A development tool | Auto-restarts the server when you save a file (dev only) |

### What Is an ORM?

Without an ORM, you'd write raw SQL:
```sql
SELECT * FROM "User" WHERE email = 'test@example.com';
```

With Prisma, you write JavaScript:
```javascript
const user = await prisma.user.findUnique({
  where: { email: 'test@example.com' }
});
```

Prisma translates your JavaScript into SQL behind the scenes.

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
├── prisma/
│   ├── schema.prisma       # Database schema — defines your tables
│   ├── prisma.config.ts    # Prisma CLI config (not used at runtime)
│   └── migrations/         # SQL files that create/modify your tables
│
└── src/
    ├── server.js           # The main application — everything starts here
    ├── lib/
    │   └── prisma.js       # Database connection setup
    └── public/
        ├── landing.html    # Tools index page (public, served at /)
        ├── drop.html       # Dead Drop UI (compose + read views)
        ├── index.html      # Admin control panel (served at /panel)
        └── login.html      # Login page
```

### What Each File Does

**`src/server.js`** — The main application file. Sets up Express, defines all routes, handles authentication, serves the Dead Drop and admin panel, and starts listening for requests.

**`src/public/landing.html`** — The public tools index. Lists available tools (currently Dead Drop) with a subtle admin link in the footer.

**`src/public/drop.html`** — The Dead Drop interface. Handles both composing (encrypting and submitting) and reading (fetching and decrypting) drops. All cryptography happens in this file using the Web Crypto API.

**`src/public/index.html`** — The admin panel. A tabbed SPA with Dashboard, Drops, Users, Database, and Settings tabs.

**`src/public/login.html`** — The admin login page. Submits credentials to `/auth/login` and redirects to `/panel` on success.

**`src/lib/prisma.js`** — Creates and exports a single database connection. Every part of the app imports this same connection.

**`prisma/schema.prisma`** — Defines the shape of your data. Models: User, Setting, Paste.

**`render.yaml`** — Tells Render.com how to build and run the app.

---

## Getting It Running

### Prerequisites

1. **Node.js** (version 18 or higher) — [nodejs.org](https://nodejs.org)
2. **PostgreSQL** — install with `sudo apt install postgresql` on Ubuntu

Verify they're installed:
```bash
node --version    # should show v18.x.x or higher
psql --version    # should show psql (PostgreSQL) 14.x or similar
```

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
DATABASE_URL="postgresql://gabbi:gabbi@localhost:5432/proj1?schema=public"
SESSION_SECRET="any-random-string-here-make-it-long"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD="your-password-here"
```

```bash
# 3. Create the PostgreSQL user and database
sudo -u postgres psql -c "CREATE USER gabbi WITH PASSWORD 'gabbi' CREATEDB;"
sudo -u postgres psql -c "CREATE DATABASE proj1 OWNER gabbi;"

# 4. Run database migrations (creates the tables)
npx prisma migrate dev

# 5. Start the server
npm run dev
```

Open **http://localhost:3000** — you'll see the tools index with Dead Drop listed. Admin panel is at `/panel`.

---

## How the Server Works

### The Request Lifecycle

When you visit `http://localhost:3000/api/users`:

```
Browser sends GET /api/users
        │
        ▼
┌─ Express receives the request ─────────────────────┐
│                                                     │
│  1. express.json() — parses JSON request bodies     │
│  2. express.urlencoded() — parses form data         │
│  3. session() — loads your session from the cookie  │
│  4. Request logger — records this request           │
│  5. requireAuth — checks if you're logged in        │
│  6. Route handler — runs the code for GET /api/users│
│                                                     │
└─────────────────────────────────────────────────────┘
        │
        ▼
Prisma queries PostgreSQL: SELECT * FROM "User"
        │
        ▼
Server sends JSON response: [{ id: 1, email: "..." }]
```

### Route Organization

Routes are split into three groups:

1. **Public routes** (no auth): `/`, `/drop`, `/drop/:id`, `/api/drop`, `/api/drop/:id`, `/auth/*`, `/login.html`
2. **Auth-protected routes**: everything else — admin panel, API endpoints
3. **Drop routes are excluded from request logging** for privacy

### Middleware

Middleware are functions that run *before* your route handler. The order matters:
1. Body parsers (so handlers can read `req.body`)
2. Session middleware (so auth can check `req.session`)
3. Request logger (records the request, skips drop routes)
4. Auth middleware blocks unauthenticated access to protected routes

---

## The Database

### Schema

The database has four tables (three you defined, one Prisma creates automatically):

**User** — application data
| Column | Type | Notes |
|--------|------|-------|
| `id` | Integer | Auto-incrementing primary key |
| `email` | String | Must be unique |
| `name` | String | Optional |
| `createdAt` | DateTime | Set automatically |
| `updatedAt` | DateTime | Set automatically |

**Setting** — key-value configuration store
| Column | Type | Notes |
|--------|------|-------|
| `key` | String | Primary key |
| `value` | String | The stored value |
| `updatedAt` | DateTime | Set automatically |

**Paste** — encrypted drops (Dead Drop)
| Column | Type | Notes |
|--------|------|-------|
| `id` | String | CUID, auto-generated |
| `encrypted` | String | AES-256-GCM ciphertext (base64url) |
| `iv` | String | Initialization vector (base64url) |
| `burnAfterRead` | Boolean | Delete after first read |
| `expiresAt` | DateTime | When the drop expires |
| `createdAt` | DateTime | Set automatically |

**_prisma_migrations** — Prisma's internal tracking table

### How Prisma Connects to PostgreSQL

This project uses **Prisma 7** with a **driver adapter** — a thin wrapper around the standard `pg` library:

```
Your code → Prisma Client → @prisma/adapter-pg → pg → PostgreSQL
```

Configured in `src/lib/prisma.js`.

### Migrations

A migration is a set of SQL commands that change your database structure:
```bash
npx prisma migrate dev --name describe-the-change
```

Current migrations:
1. `init` — creates User table
2. `add_settings` — creates Setting table
3. `add_paste_model` — creates Paste table

---

## Authentication & Security

### How Login Works

```
1. Visit /panel → requireAuth redirects to /login.html
2. Enter username + password → POST /auth/login
3. Server verifies password (scrypt hash or env var)
4. Session created → cookie sent to browser
5. All future requests include cookie → auth passes
```

### Password Verification

```
Is there a password hash in the Setting table?
    ├── YES → verify against stored scrypt hash
    └── NO → verify against ADMIN_PASSWORD env var
```

### Security Features

- **scrypt password hashing** with random salt
- **Timing-safe comparison** (prevents timing attacks)
- **httpOnly cookies** (JavaScript can't read them)
- **sameSite: lax** (prevents CSRF)
- **secure: true in production** (HTTPS only)
- **trust proxy** set for Render's reverse proxy
- **SQL injection prevention** via Prisma parameterization + table name validation
- **8-hour session expiry**

---

## Dead Drop — Zero-Knowledge Paste Bin

Dead Drop is the flagship tool. It's designed for sharing sensitive text where even the server operator cannot read the content.

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
│  Stores ciphertext + IV in database                 │
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

- **Key in URL fragment**: Browsers never transmit the `#fragment` portion of a URL to the server. The decryption key lives there.
- **No logging on drop routes**: Drop creation and retrieval are excluded from the request log. No IPs, timestamps, or user agents are recorded.
- **No cookies on drop routes**: Sessions are not used for drop operations.
- **Burn after reading**: The database row is deleted immediately after the first retrieval.
- **Auto-expiry**: Expired drops are deleted on access and can be bulk-purged by the admin.
- **256 KB limit**: Prevents abuse of storage.
- **`<meta name="referrer" content="no-referrer">`**: Prevents the browser from leaking the URL (including the key) to other sites.

### Expiry Options

| Value | Duration |
|-------|----------|
| `1h` | 1 hour |
| `24h` | 24 hours (default) |
| `7d` | 7 days |
| `30d` | 30 days |

---

## The Admin Panel

The admin panel at `/panel` is a single-page application with five tabs. All pages use a dark monospace theme.

### Dashboard

- Status cards: uptime, memory, user count, active drops
- Live request log (auto-refreshes every 5 seconds)
- Drop routes are excluded from the log for privacy

### Drops

- Stats: total, active, expired, burn-on-read counts
- Table of all drops: ID, status (active/expired), type (standard/burn), expiry countdown, creation date
- Actions: delete individual drops, purge all expired
- Note: admin cannot read drop contents (zero-knowledge)

### Users

- Add users (email + optional name)
- Inline editing
- Delete with confirmation

### Database

- Info cards: database name, size, table count, PostgreSQL version
- Table browser: sidebar with tables, click to view schema + paginated data
- Migration history

### Settings

- Change admin password
- View environment variables (sensitive values masked)
- System information (PID, Node version, OS, memory, etc.)

---

## The API

Every endpoint returns JSON.

### Public Endpoints (no auth)

| Method | URL | Body | Description |
|--------|-----|------|-------------|
| `POST` | `/api/drop` | `{ encrypted, iv, burn?, expiry? }` | Create a drop |
| `GET` | `/api/drop/:id` | — | Retrieve a drop (burns if flagged) |
| `POST` | `/auth/login` | `{ username, password }` | Log in |
| `POST` | `/auth/logout` | — | Log out |
| `GET` | `/auth/check` | — | Check auth status |
| `POST` | `/auth/change-password` | `{ currentPassword, newPassword }` | Change password (requires auth) |

### Admin Endpoints (auth required)

| Method | URL | Description |
|--------|-----|-------------|
| `GET` | `/api/status` | Server health |
| `GET` | `/api/users` | List users |
| `GET` | `/api/users/:id` | Get user |
| `POST` | `/api/users` | Create user (`{ email, name? }`) |
| `PUT` | `/api/users/:id` | Update user |
| `DELETE` | `/api/users/:id` | Delete user |
| `GET` | `/api/drops` | List drops (metadata only) |
| `GET` | `/api/drops/stats` | Drop statistics |
| `DELETE` | `/api/drops/:id` | Delete a drop |
| `POST` | `/api/drops/purge-expired` | Purge expired drops |
| `GET` | `/api/db/info` | Database info |
| `GET` | `/api/db/tables` | List tables |
| `GET` | `/api/db/tables/:name` | Table data (`?page=1&limit=25`) |
| `GET` | `/api/db/migrations` | Migration history |
| `GET` | `/api/system` | System info + env vars |
| `GET` | `/api/logs` | Request log (last 200) |

### HTTP Status Codes

| Code | Meaning | When You'll See It |
|------|---------|-------------------|
| `200` | OK | Successful read or update |
| `201` | Created | New user or drop created |
| `204` | No Content | Successful delete |
| `400` | Bad Request | Missing required field |
| `401` | Unauthorized | Not logged in or wrong password |
| `404` | Not Found | Resource doesn't exist or expired |
| `409` | Conflict | Email already exists |
| `413` | Payload Too Large | Drop exceeds 256 KB |
| `500` | Server Error | Database connection failed |

### Testing with curl

```bash
# Create a drop (normally done client-side, but for testing)
curl -X POST http://localhost:3000/api/drop \
  -H 'Content-Type: application/json' \
  -d '{"encrypted":"test","iv":"test","expiry":"1h"}'

# Admin login
curl -c cookies.txt -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"your-password"}'

# Admin: list drops
curl -b cookies.txt http://localhost:3000/api/drops
```

---

## Deploying to the Internet

### Render Deployment

The app is deployed on Render at `https://server-express-u3tu.onrender.com`.

The `render.yaml` file configures:
```yaml
buildCommand: npm install && npx prisma generate && npx prisma migrate deploy
startCommand: npm start
```

### Environment Variables on Render

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Internal Database URL from Render PostgreSQL |
| `ADMIN_PASSWORD` | Admin login password |
| `SESSION_SECRET` | Random string for session signing |
| `NODE_ENV` | `production` (set in render.yaml) |

Auto-deploys on push to `main`.

---

## Common Tasks

### Add a New Tool

1. Create the HTML file in `src/public/` (follow the dark monospace theme)
2. Add public routes in `src/server.js` before the `requireAuth` middleware
3. Add a card to `src/public/landing.html` linking to the new tool
4. If it needs database storage, add a Prisma model and migrate

### Add a New Database Table

1. Add a model to `prisma/schema.prisma`
2. Run `npx prisma migrate dev --name describe-change`
3. Use it: `const items = await prisma.modelName.findMany();`

### Reset a Forgotten Admin Password

```bash
psql proj1 -c "DELETE FROM \"Setting\" WHERE key = 'admin_password_hash';"
```

The `ADMIN_PASSWORD` env var works again.

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

### "Cannot find module '.prisma/client/default'"
Run `npx prisma generate`.

### "Can't reach database server at localhost:5432"
Start PostgreSQL: `sudo systemctl start postgresql`

### Login doesn't work on Render
Ensure `trust proxy` is set (it is). Check that `NODE_ENV=production` is set so secure cookies work over HTTPS.

### Drops show "Not found" immediately
The drop expired or was burned. Expired drops are deleted on access.

### The admin panel shows "Loading..."
Check browser console (F12). Likely a 401 (session expired) or database connection issue.
