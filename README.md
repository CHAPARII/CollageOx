# College Ox 2.0

A real-time campus community and operations platform with a completely original light UI. The database starts empty: there are no demo students, posts, clubs, projects, events, notices, or support tickets.

## Start

Requires Node.js 24+ (SQLite is built into this Node release).

```bash
npm install
cp .env.example .env
# Export the values from .env in your shell.
npm start
```

Open `http://localhost:3000`.

## Owner access

There is no built-in owner credential. On an empty database, set `OWNER_USERNAME`, `OWNER_INITIAL_PASSWORD`, and optionally `OWNER_EMAIL` and `OWNER_NAME`. Startup stops with a clear error if an empty database has no valid owner secret. The initial password must contain at least 10 characters and can be replaced after login through `POST /api/auth/password`.

Any owner password previously committed to this repository must be considered compromised and must never be reused.

## What works

- Student registration and secure username/email login
- Persistent, hashed sessions and a confirmation-based logout flow
- Live shared feed using Server-Sent Events
- Posts, reactions, comments, clipboard sharing, local saved posts, and owner deletion
- Campus user search, public profile visits, follow/unfollow, follower statistics
- Fully customizable profile: photo, name, username, bio, department, year, pronouns, location, accent, interests, links, and visibility
- Projects and team capacity, clubs and membership, events and RSVP
- Staff/owner announcements
- Saved support tickets with management status and notes
- Owner console with real database metrics and newest accounts
- Optional real AI writing assistance through the OpenAI Responses API
- Empty states everywhere—no invented activity or fake numbers
- Mobile navigation, accessible dialogs, close buttons, backdrops, and reduced motion

## Real AI configuration

AI controls clearly show as unavailable until a real provider key exists. To enable them:

```bash
export OPENAI_API_KEY="your-server-side-key"
export OPENAI_MODEL="gpt-5-mini"
npm start
```

The API key stays on the server and is never sent to the browser. `POST /api/ai/assist` is authenticated and rate-limited. Nothing claims to be AI-moderated when no provider is connected.

## Data

Local development uses SQLite by default. Production requires `DATABASE_URL` and uses PostgreSQL, so accounts, sessions, chat messages, posts, clubs, and all other records survive Render deploys and restarts. Versioned migrations run automatically at startup and are recorded in `schema_migrations`.

## Test

```bash
node --check server.js
node --check public/app.js
node --test tests/app.test.js
```

The automated suite verifies empty initial state, owner authentication, student registration, profile customization, posting, comments, following, support tickets, owner deletion, and honest AI-disabled behavior.

## Deploy

Docker:

```bash
docker build -t collegeox .
docker run --env-file .env -p 3000:3000 collegeox
```

The included `render.yaml` keeps the web service on Render Free and does not attach a paid disk. In Render, add these secret environment variables before deploying:

- `DATABASE_URL`: PostgreSQL connection string from your database provider
- `OWNER_USERNAME` and `OWNER_INITIAL_PASSWORD`: used only if the database has no owner
- `OWNER_EMAIL` and `OWNER_NAME`: optional owner details
- `OPENAI_API_KEY` and `OPENAI_MODEL`: optional AI configuration

Use an externally managed PostgreSQL database with backups. The database provider may have its own free-tier limits; changing the web service from SQLite to PostgreSQL does not upgrade the Render web service.
