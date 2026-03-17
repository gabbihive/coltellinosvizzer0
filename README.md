# Proj1

Express web application server with a PostgreSQL database, session-based authentication, and a browser-based control panel. Targets Render for deployment.

## Local Development

### Prerequisites

- **Node.js** >= 18
- **PostgreSQL** running locally

### Setup

```bash
npm install

# Copy and fill in your env vars (DATABASE_URL, ADMIN_PASSWORD required)
cp .env.example .env

# Run database migrations
npx prisma migrate dev --name init

# Start the dev server (auto-restarts on file changes)
npm run dev
```

Open **http://localhost:3000** — you'll be redirected to the login page. Default credentials: `admin` / (whatever you set as `ADMIN_PASSWORD` in `.env`).

### Production

```bash
npm start
```

## Environment Variables

Copy `.env.example` to `.env` and fill in values:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the server listens on |
| `DATABASE_URL` | — | PostgreSQL connection string (e.g. `postgresql://user:pass@localhost:5432/proj1`) |
| `ADMIN_USERNAME` | `admin` | Login username for the control panel |
| `ADMIN_PASSWORD` | — | **Required.** Login password (server won't start without it) |
| `SESSION_SECRET` | random | Secret for signing session cookies. Set a persistent value in production |

## Control Panel

The web GUI at `/` has four tabs:

- **Dashboard** — server uptime, memory, user count, and a live request log
- **Users** — create, edit, and delete users
- **Database** — browse tables, view schemas, inspect data with pagination, and see migration history
- **Settings** — change admin password, view environment variables (sensitive values masked), and system information

## API

All endpoints require authentication (session cookie). Auth routes are public.

### Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/auth/login` | Login (`{ username, password }`) |
| `POST` | `/auth/logout` | Logout (destroys session) |
| `GET` | `/auth/check` | Check if authenticated |
| `POST` | `/auth/change-password` | Change password (`{ currentPassword, newPassword }`) |

### Users

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/users` | List all users |
| `GET` | `/api/users/:id` | Get a user by ID |
| `POST` | `/api/users` | Create a user (`{ email, name? }`) |
| `PUT` | `/api/users/:id` | Update a user (`{ email?, name? }`) |
| `DELETE` | `/api/users/:id` | Delete a user |

### Server & Database

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status` | Server health, uptime, memory, user count |
| `GET` | `/api/db/info` | Database name, user, version, size |
| `GET` | `/api/db/tables` | List tables with row counts |
| `GET` | `/api/db/tables/:name` | Table schema + paginated data (`?page=1&limit=25`) |
| `GET` | `/api/db/migrations` | Migration history |
| `GET` | `/api/system` | System info and environment variables |
| `GET` | `/api/logs` | Recent request log (in-memory, last 200) |

## Project Structure

```
src/
  server.js          # Express app, auth, API routes, server start
  lib/
    prisma.js        # Shared Prisma client instance
  public/
    index.html       # Control panel GUI (tabbed SPA)
    login.html       # Login page
prisma/
  schema.prisma      # Database schema (User, Setting)
  migrations/        # Version-controlled SQL migrations
```

Add routes in `src/routes/`, middleware in `src/middleware/` as the app grows.

## Database

Uses **Prisma 7** ORM with a PostgreSQL driver adapter (`@prisma/adapter-pg`).

**Models:**
- `User` — application data (email, name, timestamps)
- `Setting` — key-value store (used for admin password hash override)

```bash
npx prisma migrate dev     # Create and apply migrations in development
npx prisma migrate deploy  # Apply migrations in production
npx prisma generate        # Regenerate client after schema changes
npx prisma studio          # Visual database browser
```

## Deploying to Render

1. Push this repository to GitHub.
2. In Render, create a new **Web Service** and connect the repo.
3. Render auto-detects `render.yaml` — build and start commands are already configured.
4. Add these secrets under the service's **Environment** tab:
   - `DATABASE_URL` — your Render Postgres connection string
   - `ADMIN_PASSWORD` — admin login password
   - `SESSION_SECRET` — a random string for signing session cookies
5. Render sets `PORT` automatically; the server already reads it.

Auto-deploy is on by default — Render redeploys when you push new commits.
