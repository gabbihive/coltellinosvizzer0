# server-express

Self-hosted tools platform with an admin control panel. Built with Node.js, Express, Prisma, and PostgreSQL. Deployed on Render.

## Tools

### Dead Drop

Zero-knowledge encrypted paste bin at `/drop`. Designed for sharing sensitive text anonymously.

- **Client-side AES-256-GCM encryption** — content is encrypted in the browser before reaching the server
- **Key in URL fragment** — the decryption key is after `#` in the URL, which browsers never send to the server
- **Burn after reading** — optionally destroy the message after one view
- **Auto-expiry** — 1 hour, 24 hours, 7 days, or 30 days
- **No traces** — no logging, no IP tracking, no cookies, no metadata on drop routes
- **256 KB max** per paste

The server stores only ciphertext. It cannot read drop contents even if compromised.

## Admin Panel

Authenticated control panel at `/panel` (login at `/login.html`).

**Tabs:**
- **Dashboard** — uptime, memory, user count, active drops, request log
- **Drops** — view/delete encrypted drops, purge expired, stats
- **Users** — CRUD for application users
- **Database** — browse tables, view schemas, inspect data, migration history
- **Settings** — change password, environment variables, system info

## Local Development

### Prerequisites

- Node.js >= 18
- PostgreSQL running locally

### Setup

```bash
npm install
cp .env.example .env    # fill in DATABASE_URL, ADMIN_PASSWORD
npx prisma migrate dev
npm run dev
```

Open `http://localhost:3000` — the tools index. Admin panel at `/panel`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `ADMIN_USERNAME` | `admin` | Admin login username |
| `ADMIN_PASSWORD` | — | **Required.** Admin login password |
| `SESSION_SECRET` | random | Session cookie signing secret (set in production) |

## API

All `/api/*` endpoints require authentication except `/api/drop` (public).

### Public (no auth)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/drop` | Create encrypted drop (`{ encrypted, iv, burn?, expiry? }`) |
| `GET` | `/api/drop/:id` | Retrieve encrypted drop (deletes if burn-after-read) |

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
| `GET` | `/api/users` | List users |
| `POST` | `/api/users` | Create user (`{ email, name? }`) |
| `PUT` | `/api/users/:id` | Update user |
| `DELETE` | `/api/users/:id` | Delete user |
| `GET` | `/api/drops` | List all drops (metadata only) |
| `GET` | `/api/drops/stats` | Drop statistics |
| `DELETE` | `/api/drops/:id` | Delete a drop |
| `POST` | `/api/drops/purge-expired` | Delete all expired drops |
| `GET` | `/api/db/info` | Database info |
| `GET` | `/api/db/tables` | List tables |
| `GET` | `/api/db/tables/:name` | Table data (`?page=1&limit=25`) |
| `GET` | `/api/db/migrations` | Migration history |
| `GET` | `/api/system` | System info + env vars |
| `GET` | `/api/logs` | Request log (last 200) |

## Project Structure

```
src/
  server.js              # Express app, all routes
  lib/
    prisma.js            # Shared Prisma client
  public/
    landing.html         # Tools index (/)
    drop.html            # Dead Drop UI (/drop)
    index.html           # Admin panel (/panel)
    login.html           # Login page
prisma/
  schema.prisma          # Database schema (User, Setting, Paste)
  migrations/            # SQL migrations
```

## Database

Prisma 7 with PostgreSQL driver adapter. Models:

- **User** — email, name, timestamps
- **Setting** — key-value store (admin password hash)
- **Paste** — encrypted content, IV, burn flag, expiry timestamp

## Deploying to Render

1. Push to GitHub
2. Create a PostgreSQL database on Render
3. Create a Web Service, connect the repo
4. Set `DATABASE_URL` (Internal Database URL), `ADMIN_PASSWORD`, `SESSION_SECRET` in Environment
5. Build command: `npm install && npx prisma generate && npx prisma migrate deploy`
6. Start command: `npm start`

Auto-deploys on push.
