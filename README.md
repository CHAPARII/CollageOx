# College Ox 2.0

A real-time campus community and operations platform with a completely original light UI. The database starts empty: there are no demo students, posts, clubs, projects, events, notices, or support tickets.

## Start

Requires Node.js 24+ (SQLite is built into this Node release).

```bash
npm start
```

Open `http://localhost:3000`.

## Owner access

The single built-in owner identity requested for this deployment is:

- Username: `Navi`
- Password: `Ashish1315e@own`

The source contains only a PBKDF2 password hash, never the plaintext password. The owner can remove any post, publish notices, view real platform metrics, and review/update all saved support issues.

Change the owner password before sharing the source publicly. In a full production rollout, move owner bootstrap into a one-time deployment secret.

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

## Data and scale

The app uses SQLite with WAL mode, foreign keys, atomic transactions, indexes implied by unique/primary keys, and persistent sessions. This comfortably stores 10,000+ student accounts and is appropriate for an initial single-server campus launch.

For heavy simultaneous usage across multiple application servers, move the same schema to managed PostgreSQL and use Redis pub/sub for cross-instance live events. SQLite is a single-host database; claiming otherwise would be misleading. Put the app behind HTTPS, use institutional SSO/email verification, add backups, and load-test against your expected peak concurrency before a campus-wide rollout.

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
docker run -p 3000:3000 -v collegeox-data:/app/data collegeox
```

The included `render.yaml` provisions a persistent disk and health check. Configure `NODE_ENV=production`, attach persistent storage, and optionally set `OPENAI_API_KEY` and `OPENAI_MODEL`.
