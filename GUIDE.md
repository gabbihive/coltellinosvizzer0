# Proj1 — The Complete Guide

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
8. [The Control Panel (GUI)](#the-control-panel-gui)
9. [The API](#the-api)
10. [Deploying to the Internet](#deploying-to-the-internet)
11. [Common Tasks](#common-tasks)
12. [Troubleshooting](#troubleshooting)

---

## What Is This Project?

Proj1 is a **web server** — a program that runs on a computer and responds to requests from web browsers and other programs. It provides:

- A **control panel** you open in your browser to manage data
- A **REST API** (a set of URLs) that programs can call to read and write data
- A **PostgreSQL database** to store data permanently
- **Login protection** so only you can access it

Think of it like a simple version of an admin dashboard you'd find behind a website.

---

## The Technology Stack

Here's every technology used and what role it plays:

| Technology | What It Is | What It Does Here |
|---|---|---|
| **Node.js** | A JavaScript runtime | Runs the server code (JavaScript outside a browser) |
| **Express** | A web framework for Node.js | Handles HTTP requests, routing, and middleware |
| **PostgreSQL** | A relational database | Stores users, settings, and any future data permanently |
| **Prisma** | An ORM (Object-Relational Mapper) | Lets you work with the database using JavaScript instead of writing raw SQL |
| **dotenv** | An env var loader | Reads the `.env` file so you can configure the app without changing code |
| **express-session** | Session middleware | Keeps you logged in between page loads using browser cookies |
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
│       ├── 20260314..._init/
│       │   └── migration.sql
│       └── 20260314..._add_settings/
│           └── migration.sql
│
└── src/
    ├── server.js           # The main application — everything starts here
    ├── lib/
    │   └── prisma.js       # Database connection setup
    └── public/
        ├── index.html      # The control panel (what you see in the browser)
        └── login.html      # The login page
```

### What Each File Does

**`package.json`** — Lists the project's dependencies (libraries it needs) and defines scripts like `npm start` and `npm run dev`. When you run `npm install`, Node.js reads this file and downloads everything listed.

**`.env`** — Your local configuration. Contains your database connection string, admin password, and session secret. This file is in `.gitignore` so it never gets uploaded to GitHub.

**`.env.example`** — A template showing what variables `.env` needs, with placeholder values. Safe to commit.

**`prisma/schema.prisma`** — Defines the shape of your data. When you write a model here and run a migration, Prisma creates the corresponding table in PostgreSQL.

**`prisma/migrations/`** — Each subfolder contains a `migration.sql` file with the SQL that was run to create or change your database tables. These are generated automatically by Prisma and should be committed to Git so that any database can be set up from scratch.

**`src/server.js`** — The main application file. It sets up Express, defines all the routes (URLs the server responds to), handles authentication, and starts listening for requests.

**`src/lib/prisma.js`** — Creates and exports a single database connection. Every part of the app imports this same connection instead of creating its own.

**`src/public/index.html`** — The control panel GUI. It's a single HTML file with embedded CSS and JavaScript that calls the API and renders the results. No build step or framework needed.

**`src/public/login.html`** — The login page. Submits credentials to `/auth/login` and redirects to the control panel on success.

**`render.yaml`** — Tells Render.com how to build and run the app. Render reads this file automatically when you connect your GitHub repository.

---

## Getting It Running

### Prerequisites

You need two things installed:

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

Now open `.env` in a text editor and fill in real values:
```
PORT=3000
DATABASE_URL="postgresql://gabbi:gabbi@localhost:5432/proj1?schema=public"
SESSION_SECRET="any-random-string-here-make-it-long"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD="your-password-here"
```

The `DATABASE_URL` breaks down like this:
```
postgresql://USERNAME:PASSWORD@HOST:PORT/DATABASE_NAME?schema=public
             ───┬───  ───┬──  ──┬─ ─┬─  ─────┬─────
                │       │      │   │        └─ The database to connect to
                │       │      │   └─ PostgreSQL's default port
                │       │      └─ localhost = your own machine
                │       └─ The database user's password
                └─ The database user
```

```bash
# 3. Create the PostgreSQL user and database
sudo -u postgres psql -c "CREATE USER gabbi WITH PASSWORD 'gabbi' CREATEDB;"
sudo -u postgres psql -c "CREATE DATABASE proj1 OWNER gabbi;"

# 4. Run database migrations (creates the tables)
npx prisma migrate dev --name init

# 5. Start the server
npm run dev
```

Open **http://localhost:3000** in your browser. You'll see a login page. Enter the username and password you set in `.env`.

---

## How the Server Works

### The Request Lifecycle

When you visit `http://localhost:3000/api/users`, here's what happens:

```
Browser sends GET /api/users
        │
        ▼
┌─ Express receives the request ─────────────────────┐
│                                                     │
│  1. express.json() — parses JSON request bodies     │
│  2. express.urlencoded() — parses form data         │
│  3. session() — loads your session from the cookie   │
│  4. Request logger — records this request            │
│  5. requireAuth — checks if you're logged in         │
│  6. Route handler — runs the code for GET /api/users │
│                                                     │
└─────────────────────────────────────────────────────┘
        │
        ▼
Prisma queries PostgreSQL: SELECT * FROM "User"
        │
        ▼
Server sends JSON response: [{ id: 1, email: "..." }]
```

### Middleware

Middleware are functions that run *before* your route handler. They sit in the middle (hence the name) between the request arriving and your code running. Each one can:

- Modify the request (e.g., parse JSON from the body)
- End the request early (e.g., return 401 if not logged in)
- Pass control to the next middleware with `next()`

The order matters. In this app:
1. Body parsers run first (so route handlers can read `req.body`)
2. Session middleware runs next (so auth can check `req.session`)
3. Request logger records the request
4. Auth middleware blocks unauthenticated access
5. Static file server or route handler runs last

### Routes

A route is a URL pattern + HTTP method paired with a handler function:

```javascript
app.get('/api/users', async (req, res) => {
  // This runs when someone sends GET /api/users
  const users = await prisma.user.findMany();
  res.json(users);
});
```

- `app.get()` — handles GET requests (reading data)
- `app.post()` — handles POST requests (creating data)
- `app.put()` — handles PUT requests (updating data)
- `app.delete()` — handles DELETE requests (deleting data)

---

## The Database

### Schema

The database has three tables (two you defined, one Prisma creates automatically):

**User** — application data
| Column | Type | Notes |
|--------|------|-------|
| `id` | Integer | Auto-incrementing primary key |
| `email` | String | Must be unique |
| `name` | String | Optional |
| `createdAt` | DateTime | Set automatically when created |
| `updatedAt` | DateTime | Set automatically when modified |

**Setting** — key-value configuration store
| Column | Type | Notes |
|--------|------|-------|
| `key` | String | Primary key (e.g., `admin_password_hash`) |
| `value` | String | The stored value |
| `updatedAt` | DateTime | Set automatically when modified |

**_prisma_migrations** — Prisma's internal tracking table
| Column | Notes |
|--------|-------|
| `migration_name` | Name of the migration (e.g., `20260314_init`) |
| `started_at` | When it was applied |
| `finished_at` | When it completed |

### How Prisma Connects to PostgreSQL

This project uses **Prisma 7**, which works differently from older versions. Instead of a built-in database engine, it uses a **driver adapter** — a thin wrapper around the standard `pg` (node-postgres) library:

```
Your code
    │
    ▼
Prisma Client — translates .findMany(), .create(), etc. into SQL
    │
    ▼
@prisma/adapter-pg — passes the SQL to the pg driver
    │
    ▼
pg (node-postgres) — sends the SQL over TCP to PostgreSQL
    │
    ▼
PostgreSQL — executes the query and returns results
```

This is configured in `src/lib/prisma.js`:
```javascript
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });
```

### Migrations

A migration is a set of SQL commands that change your database structure. When you add a model to `schema.prisma`, you run:

```bash
npx prisma migrate dev --name describe-the-change
```

This does three things:
1. Compares your schema to the current database
2. Generates a SQL file with the necessary `CREATE TABLE` / `ALTER TABLE` commands
3. Runs that SQL against your database

The SQL files are saved in `prisma/migrations/` and committed to Git. When someone else clones the project, they run `npx prisma migrate dev` to set up the same database structure.

### Prisma Studio

Prisma includes a visual database browser:
```bash
npx prisma studio
```
This opens a web UI at `http://localhost:5555` where you can view and edit data directly. Useful for debugging.

---

## Authentication & Security

### How Login Works

```
1. You visit http://localhost:3000
       │
       ▼
2. requireAuth middleware sees you have no session
       │
       ▼
3. You're redirected to /login.html
       │
       ▼
4. You enter username + password, click "Sign in"
       │
       ▼
5. Browser sends POST /auth/login { username, password }
       │
       ▼
6. Server verifies the password (see below)
       │
       ▼
7. Server creates a session: req.session.authenticated = true
       │
       ▼
8. Server sends back a cookie: connect.sid=abc123...
       │
       ▼
9. Browser stores the cookie and redirects to /
       │
       ▼
10. Every future request includes the cookie automatically
        │
        ▼
11. requireAuth sees the session is valid — request proceeds
```

### Password Verification Flow

The server checks passwords in a specific order:

```
Is there a password hash stored in the Setting table?
    │
    ├── YES → verify against the stored hash (scrypt)
    │         (the .env password is IGNORED)
    │
    └── NO → verify against ADMIN_PASSWORD from .env
              (constant-time comparison)
```

This means:
- **First time**: you log in with the password from `.env`
- **After changing password in Settings**: the new password (stored as a hash in the database) takes over
- **Recovery**: if you forget the new password, delete the `admin_password_hash` row from the `Setting` table, and the `.env` password works again

### Password Hashing

Passwords are never stored in plain text. When you change your password, the server:

1. Generates 16 random bytes (the **salt**)
2. Runs `scrypt(password, salt, 64)` — a deliberately slow algorithm that's hard to brute-force
3. Stores the result as `salt:hash` in the database

To verify a login, it re-runs scrypt with the same salt and compares the output using `crypto.timingSafeEqual()`, which takes the same amount of time regardless of whether the password is right or wrong (preventing **timing attacks**).

### Session Security

The session cookie has these protections:

| Setting | Value | What It Prevents |
|---------|-------|-----------------|
| `httpOnly` | `true` | JavaScript can't read the cookie (prevents XSS cookie theft) |
| `sameSite` | `lax` | Cookie isn't sent on cross-site POST requests (prevents CSRF) |
| `secure` | `true` in production | Cookie only sent over HTTPS (prevents network sniffing) |
| `maxAge` | 8 hours | Session expires automatically |

---

## The Control Panel (GUI)

The control panel is a **single-page application** (SPA) — one HTML file that dynamically updates its content using JavaScript, without full page reloads.

### Dashboard Tab

- **Status cards**: server uptime, memory usage, total users, Node.js version
- **Recent Activity**: a live table of API requests showing method, path, HTTP status (color-coded), and response time
- Auto-refreshes every 5 seconds

### Users Tab

- **Add User form**: enter an email (required) and name (optional)
- **Users table**: lists all users with inline editing and delete buttons
- Handles errors like duplicate emails (409) and missing users (404)

### Database Tab

- **Info cards**: database name, size on disk, number of tables, PostgreSQL version
- **Table Browser**: click any table on the left to see its schema (column names, types, nullable, defaults) and browse its data with pagination (25 rows per page)
- **Migration History**: shows every migration that has been applied, when, and how many SQL steps it had

### Settings Tab

- **Change Password**: requires current password, new password (min 8 characters), and confirmation
- **Environment Variables**: shows all env vars with sensitive values (passwords, secrets, keys) masked as bullet characters
- **System Information**: PID, Node version, OS, CPU count, memory usage, working directory

### How the GUI Talks to the Server

The control panel uses the browser's built-in `fetch()` function to call the API:

```javascript
// Get all users
const response = await fetch('/api/users');
const users = await response.json();

// Create a user
await fetch('/api/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'new@example.com', name: 'New User' }),
});
```

If any API call returns `401 Unauthorized` (session expired), the page automatically redirects to the login screen.

---

## The API

Every endpoint returns JSON. All endpoints except `/auth/*` require an authenticated session.

### Auth Endpoints

| Method | URL | Request Body | What It Does |
|--------|-----|-------------|--------------|
| `POST` | `/auth/login` | `{ username, password }` | Log in, receive a session cookie |
| `POST` | `/auth/logout` | (none) | Destroy the session |
| `GET` | `/auth/check` | (none) | Returns `{ authenticated: true/false }` |
| `POST` | `/auth/change-password` | `{ currentPassword, newPassword }` | Change the admin password (min 8 chars) |

### User Endpoints

| Method | URL | Request Body | What It Does |
|--------|-----|-------------|--------------|
| `GET` | `/api/users` | — | List all users |
| `GET` | `/api/users/:id` | — | Get one user by ID |
| `POST` | `/api/users` | `{ email, name? }` | Create a user (email must be unique) |
| `PUT` | `/api/users/:id` | `{ email?, name? }` | Update a user |
| `DELETE` | `/api/users/:id` | — | Delete a user |

### Server & Database Endpoints

| Method | URL | What It Returns |
|--------|-----|----------------|
| `GET` | `/api/status` | Uptime, memory, user count, Node version |
| `GET` | `/api/db/info` | Database name, user, PostgreSQL version, size |
| `GET` | `/api/db/tables` | List of tables with row counts |
| `GET` | `/api/db/tables/:name?page=1&limit=25` | Table schema + paginated data |
| `GET` | `/api/db/migrations` | Migration history |
| `GET` | `/api/system` | System info + environment variables (sensitive masked) |
| `GET` | `/api/logs` | Recent request log (last 200, in-memory) |

### HTTP Status Codes

| Code | Meaning | When You'll See It |
|------|---------|-------------------|
| `200` | OK | Successful read or update |
| `201` | Created | New user created successfully |
| `204` | No Content | User deleted successfully |
| `400` | Bad Request | Missing required field (e.g., no email) |
| `401` | Unauthorized | Not logged in, or wrong password |
| `404` | Not Found | User or table doesn't exist |
| `409` | Conflict | Email already exists (unique constraint) |
| `500` | Server Error | Database connection failed or internal error |

### Testing the API with curl

```bash
# Log in and save the session cookie
curl -c cookies.txt -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"your-password"}'

# Use the cookie for subsequent requests
curl -b cookies.txt http://localhost:3000/api/users

curl -b cookies.txt -X POST http://localhost:3000/api/users \
  -H 'Content-Type: application/json' \
  -d '{"email":"hello@example.com","name":"Test User"}'

curl -b cookies.txt http://localhost:3000/api/db/info
```

---

## Deploying to the Internet

This project is configured for **Render.com**, a hosting platform that can run Node.js apps and PostgreSQL databases.

### What Happens on Deploy

The `render.yaml` file tells Render:
```yaml
buildCommand: npm install && npx prisma generate && npx prisma migrate deploy
startCommand: npm start
```

1. **`npm install`** — downloads all dependencies
2. **`npx prisma generate`** — generates the Prisma Client code
3. **`npx prisma migrate deploy`** — applies any pending migrations to the production database
4. **`npm start`** — runs `node src/server.js`

### Step-by-Step Deployment

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) and create a free account
3. Create a **PostgreSQL** database — copy the **Internal Database URL**
4. Create a **Web Service** — connect your GitHub repo
5. Render detects `render.yaml` automatically
6. Under **Environment**, add these secrets:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | The internal database URL from step 3 |
| `ADMIN_PASSWORD` | A strong password for the control panel |
| `SESSION_SECRET` | A long random string (e.g., run `openssl rand -hex 32`) |

7. Click **Deploy** — Render builds and starts the app
8. Visit your app's URL (e.g., `https://proj1-xxxx.onrender.com`)

Render automatically redeploys when you push new commits to GitHub.

---

## Common Tasks

### Add a New Database Table

1. Edit `prisma/schema.prisma` — add a new model:
   ```prisma
   model Post {
     id        Int      @id @default(autoincrement())
     title     String
     content   String?
     createdAt DateTime @default(now())
   }
   ```

2. Generate and apply the migration:
   ```bash
   npx prisma migrate dev --name add-posts
   ```

3. Use it in your code:
   ```javascript
   const posts = await prisma.post.findMany();
   ```

### Add a New API Route

Add it in `src/server.js` after the existing routes, before `app.listen()`:

```javascript
app.get('/api/posts', async (req, res) => {
  const posts = await prisma.post.findMany();
  res.json(posts);
});
```

Since it's placed after `requireAuth`, it's automatically protected.

### Reset a Forgotten Admin Password

If you changed the password in Settings and forgot it:
```bash
# Connect to the database and delete the password override
psql proj1 -c "DELETE FROM \"Setting\" WHERE key = 'admin_password_hash';"
```

Now the password from `.env` (`ADMIN_PASSWORD`) works again.

### View Raw Database Data

```bash
# Prisma's built-in browser
npx prisma studio

# Or use psql directly
psql proj1
\dt              -- list tables
SELECT * FROM "User";
```

---

## Troubleshooting

### "ADMIN_PASSWORD env var is required"

You haven't set `ADMIN_PASSWORD` in your `.env` file. Copy the example and fill it in:
```bash
cp .env.example .env
# Then edit .env and set ADMIN_PASSWORD
```

### "Cannot find module '../generated/prisma'"

The Prisma client hasn't been generated. Run:
```bash
npx prisma generate
```

### "Can't reach database server at localhost:5432"

PostgreSQL isn't running. Start it:
```bash
sudo systemctl start postgresql
```

### "relation 'User' does not exist"

The migrations haven't been applied. Run:
```bash
npx prisma migrate dev
```

### "P2002: Unique constraint violation"

You tried to create a user with an email that already exists. Each email must be unique.

### The server starts but the control panel shows "Loading..."

Check the browser's developer console (F12 > Console tab) for errors. Common causes:
- The API is returning 401 (session expired — try logging in again)
- The database is unreachable (check `DATABASE_URL` in `.env`)
