# Campus Suite Campus Services and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Marketplace, Lost & Found, Campus Q&A, event calendar/reminders, optional push notifications, final navigation integration, and complete release verification.

**Architecture:** Campus services are separate PR #8 routers backed by forward-only tables. Contact flows reuse 1-to-1 DMs. Event reminders reuse the existing notification table and are generated opportunistically on active server/user traffic so Render Free remains supported. Push is an optional delivery layer only.

**Tech Stack:** Node.js 24, SQLite, PostgreSQL, vanilla JS/CSS, PWA service worker, optional Web Push/VAPID.

**Spec:** `docs/superpowers/specs/2026-08-20-pr7-campus-suite-design.md`

## Global Constraints

- Marketplace has no checkout/payment processing.
- Lost & Found statuses are Lost, Found, Returned.
- Anonymous Q&A hides identity publicly but owner/management moderation can identify the author.
- Answers are always attributed.
- Push configuration is optional and must never block core notifications.
- Render Free sleep means reminder push while fully asleep is best-effort only; reconnect catch-up is required.

---

### Task 1: Campus service schema

**Files:**
- Modify: `src/db/migrations.js`
- Test: `tests/pr8-campus-migrations.test.js`

**Interfaces:**
- Produces: `marketplace_listings`, `lost_found_entries`, `questions`, `answers`, `answer_votes`, `event_reminders`, `push_subscriptions`.

- [ ] **Step 1: Write failing schema assertions**

```js
for (const name of ['marketplace_listings','lost_found_entries','questions','answers','answer_votes','event_reminders','push_subscriptions']) {
  assert.ok(await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]));
}
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/pr8-campus-migrations.test.js`
Expected: FAIL on missing tables.

- [ ] **Step 3: Add versions 8 and 9**

Version 8 covers marketplace/lost-found/Q&A. Version 9 covers reminders/push. Add active/status/date indexes and unique answer-vote and reminder keys.

- [ ] **Step 4: Run migration tests**

Run: `node --test tests/pr8-campus-migrations.test.js tests/pr8-migrations.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.js tests/pr8-campus-migrations.test.js
git commit -m "Add campus services schema"
```

### Task 2: Marketplace

**Files:**
- Create: `src/pr8/marketplace.js`
- Create: `public/pr8/marketplace.js`
- Test: `tests/pr8-marketplace.test.js`

**Interfaces:**
- Routes: `GET/POST /api/marketplace`, `GET/PATCH /api/marketplace/:id`, `POST /api/marketplace/:id/contact`.
- Listing types: `sell|buy|borrow|giveaway`.
- Statuses: `active|reserved|sold|closed|expired`.

- [ ] **Step 1: Write lifecycle tests**

```js
const listing = await post('/api/marketplace', { type:'sell', title:'Calculator', priceInr:500, description:'Working well', location:'Block C' });
assert.equal(listing.data.listing.status, 'active');
```

Assert only owner can change status, non-INR/negative price is rejected for sell listings, expired items are excluded from normal search, and contact creates/reuses a DM conversation rather than exposing private contact data.

- [ ] **Step 2: Run failing tests**

Run: `node --test tests/pr8-marketplace.test.js`
Expected: FAIL on missing routes.

- [ ] **Step 3: Implement listing service and DM contact**

Use optional compressed image via media abstraction. A contact endpoint returns `conversationId` after block checks. No payment fields or payment links are generated.

- [ ] **Step 4: Build Marketplace UI**

Add filters for type/status/category, listing cards, create/edit dialog, owner status controls, and `Message seller/buyer` action.

- [ ] **Step 5: Verify and commit**

Run: `node --check public/pr8/marketplace.js && node --test tests/pr8-marketplace.test.js`
Expected: PASS.

```bash
git add src/pr8/marketplace.js public/pr8/marketplace.js tests/pr8-marketplace.test.js
git commit -m "Add campus marketplace"
```

### Task 3: Lost & Found

**Files:**
- Create: `src/pr8/lost-found.js`
- Create: `public/pr8/lost-found.js`
- Test: `tests/pr8-lost-found.test.js`

**Interfaces:**
- Routes: `GET/POST /api/lost-found`, `GET/PATCH /api/lost-found/:id`, `POST /api/lost-found/:id/contact`.
- Statuses: `lost|found|returned`.

- [ ] **Step 1: Write lifecycle tests**

```js
const item = await post('/api/lost-found', { status:'lost', name:'Black wallet', description:'Black leather wallet', location:'Library', occurredOn:'2026-08-20' });
assert.equal(item.data.item.status, 'lost');
```

Assert only reporter/management changes status and Returned items are omitted from the default active feed but remain in owner history.

- [ ] **Step 2: Run failing tests**

Run: `node --test tests/pr8-lost-found.test.js`
Expected: FAIL on missing routes.

- [ ] **Step 3: Implement item service and DM contact**

Validate approximate date/location and optional image. Contact returns a DM conversation after block checks.

- [ ] **Step 4: Build Lost & Found UI**

Add Lost/Found filters, active/returned history, create dialog, contact action, and `Mark returned` for owners.

- [ ] **Step 5: Verify and commit**

Run: `node --check public/pr8/lost-found.js && node --test tests/pr8-lost-found.test.js`
Expected: PASS.

```bash
git add src/pr8/lost-found.js public/pr8/lost-found.js tests/pr8-lost-found.test.js
git commit -m "Add lost and found"
```

### Task 4: Campus Q&A

**Files:**
- Create: `src/pr8/qa.js`
- Create: `public/pr8/qa.js`
- Test: `tests/pr8-qa.test.js`

**Interfaces:**
- Routes: `GET/POST /api/questions`, `GET /api/questions/:id`, `POST /api/questions/:id/answers`, `POST /api/answers/:id/vote`, `POST /api/questions/:id/accept/:answerId`.

- [ ] **Step 1: Write anonymity/answer tests**

```js
const q = await post('/api/questions', { title:'Hostel process?', body:'How does allotment work?', anonymous:true });
const publicView = await get(`/api/questions/${q.data.question.id}`);
assert.equal(publicView.question.author, null);
```

Assert owner/management moderation view includes author ID for anonymous questions, answers are attributed, only question author accepts an answer, and each user has one upvote per answer.

- [ ] **Step 2: Run failing tests**

Run: `node --test tests/pr8-qa.test.js`
Expected: FAIL on missing routes.

- [ ] **Step 3: Implement Q&A service**

Questions store author ID regardless of anonymity. Public serializer drops author fields when anonymous. Reuse mention/hashtag indexing for question/answer text. Accepted answer is unique per question.

- [ ] **Step 4: Build Q&A UI**

Question list, ask dialog with anonymous toggle, answer thread, upvote control, accepted-answer highlight, and management report hooks.

- [ ] **Step 5: Verify and commit**

Run: `node --check public/pr8/qa.js && node --test tests/pr8-qa.test.js`
Expected: PASS.

```bash
git add src/pr8/qa.js public/pr8/qa.js tests/pr8-qa.test.js
git commit -m "Add campus questions and answers"
```

### Task 5: Event calendar and reminders

**Files:**
- Create: `src/pr8/reminders.js`
- Create: `public/pr8/calendar.js`
- Test: `tests/pr8-reminders.test.js`

**Interfaces:**
- Routes: `GET /api/events/calendar?from=&to=`, `PUT /api/events/:id/reminder`, `DELETE /api/events/:id/reminder`.
- Helper: `processDueReminders(userId?, nowMs?)`.

- [ ] **Step 1: Write due/catch-up tests**

```js
await put(`/api/events/${event.id}/reminder`, { minutesBefore:60 });
await processDueReminders(user.id, eventTime - 30 * 60 * 1000);
assert.equal((await get('/api/notifications')).notifications.some(n => n.kind === 'event_reminder'), true);
```

Assert reminder creation is idempotent and catch-up creates a reminder once after a sleeping interval.

- [ ] **Step 2: Run failing tests**

Run: `node --test tests/pr8-reminders.test.js`
Expected: FAIL on missing functionality.

- [ ] **Step 3: Implement reminder processor**

Store due timestamp at reminder creation. Process due rows on authenticated PR8 requests and on reconnect/presence touch with a bounded batch. Mark `sent_at` in the same transaction that inserts the notification to prevent duplicates.

- [ ] **Step 4: Build month/agenda calendar UI**

Events route gains `Cards | Month | Agenda` toggle. Event detail offers reminder presets 1 hour, 1 day, and 1 week where valid.

- [ ] **Step 5: Verify and commit**

Run: `node --check public/pr8/calendar.js && node --test tests/pr8-reminders.test.js`
Expected: PASS.

```bash
git add src/pr8/reminders.js public/pr8/calendar.js tests/pr8-reminders.test.js
git commit -m "Add event calendar and reminders"
```

### Task 6: Optional push notifications

**Files:**
- Create: `src/pr8/push.js`
- Create: `public/pr8/push.js`
- Modify: `public/sw.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `tests/pr8-push.test.js`

**Interfaces:**
- Routes: `GET /api/push/config`, `POST /api/push/subscriptions`, `DELETE /api/push/subscriptions`.
- Produces: `deliverPush(userId, notification)` that resolves even when push is unavailable.

- [ ] **Step 1: Write fallback tests**

```js
process.env.VAPID_PUBLIC_KEY = '';
assert.equal((await deliverPush(user.id, { title:'Test', body:'Hello' })).delivered, false);
assert.equal((await get('/api/notifications')).response.status, 200);
```

- [ ] **Step 2: Run failing tests**

Run: `node --test tests/pr8-push.test.js`
Expected: FAIL because push module is missing.

- [ ] **Step 3: Implement optional web-push integration**

Add `web-push` dependency. Configure only when public/private VAPID keys and subject are present. Invalid/expired subscriptions are removed after permanent delivery errors. Delivery failure is logged and never rolls back the underlying notification.

- [ ] **Step 4: Add permission/settings UI and service-worker handlers**

Never prompt automatically on page load. User explicitly enables push in Settings. Service worker handles `push` and `notificationclick` and opens the related CollegeOx route.

- [ ] **Step 5: Verify and commit**

Run: `node --check public/pr8/push.js && node --test tests/pr8-push.test.js`
Expected: PASS with no VAPID configuration.

```bash
git add src/pr8/push.js public/pr8/push.js public/sw.js package.json package-lock.json tests/pr8-push.test.js
git commit -m "Add optional PWA push notifications"
```

### Task 7: Final navigation, reporting, privacy and regression release gate

**Files:**
- Modify: `public/pr8/app.js`
- Modify: `public/pr8/pr8.css`
- Modify: `src/pr8/index.js`
- Modify: `src/runtime-enhancements.js` only where PR #6 interoperability requires it
- Test: `tests/pr8-regression.test.js`

**Interfaces:**
- Adds sidebar destinations: Messages, Marketplace, Lost & Found, Q&A.
- Expands report targets without exposing arbitrary DM contents.

- [ ] **Step 1: Write end-to-end API regression assertions**

```js
assert.equal((await get('/api/bootstrap')).response.status, 200);
assert.equal((await get('/api/search?q=test&type=all')).response.status, 200);
assert.equal((await get('/api/dm/conversations')).response.status, 200);
```

Include privacy checks for private users, bidirectional blocks, anonymous Q&A, anonymous poll voters, archived entities, and no DM-content exposure through ordinary report APIs.

- [ ] **Step 2: Run complete test suite before final fixes**

Run: `npm test`
Expected: identify all failures; do not merge with any failure.

- [ ] **Step 3: Fix only failures caused by PR #8 and verify static/runtime compatibility**

Ensure PR #6 share links, realtime refresh, PWA cache busting, password settings, support issues, owner console, and existing club chat remain operational. Keep CSP headers on enhanced HTML.

- [ ] **Step 4: Run release verification**

Run:

```bash
npm test
node --check src/pr8/index.js
node --check public/pr8/app.js
NODE_ENV=production DATABASE_URL="$DATABASE_URL" node -r ./src/runtime-enhancements.js -r ./src/pr8/index.js -r ./src/static-enhancements.js server.js
```

Expected: all tests PASS; syntax checks exit 0; production startup reaches listening state when a PostgreSQL URL is supplied. If no `DATABASE_URL` is available in the environment, record PostgreSQL startup as unverified rather than claiming it passed.

- [ ] **Step 5: Review diff and commit release polish**

```bash
git status --short
git diff --check
git add public/pr8 src/pr8 tests src/db/migrations.js src/static-enhancements.js public/sw.js package.json package-lock.json Dockerfile
git commit -m "Complete campus suite integration"
```

PR is ready for review only after the complete suite has zero failures and the final GitHub diff contains only planned CollegeOx changes.
