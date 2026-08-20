# Campus Suite Foundation and Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the shared PR #8 feature runtime, forward-only schema, block/mute/presence foundation, 1-to-1 DMs, and notification/realtime plumbing without breaking PR #6 behavior.

**Architecture:** Keep `server.js` and `public/app.js` compatible. A single preload `src/pr8/index.js` wraps the existing PR #6 server once and dispatches focused feature routers that all share the PR #6 database export and one event hub. Frontend PR #8 code is injected as a module bundle from `public/pr8/app.js`.

**Tech Stack:** Node.js 24, node:http, SQLite (`node:sqlite`), PostgreSQL (`pg`), SSE, vanilla browser JavaScript/CSS.

**Spec:** `docs/superpowers/specs/2026-08-20-pr7-campus-suite-design.md`

## Global Constraints

- One implementation PR; no direct writes to upstream `main`.
- SQLite local development and PostgreSQL/Neon production must share behavior.
- No paid Render disk, worker, Redis, or mandatory third-party service.
- Migrations 1-3 are immutable; new migrations are forward-only.
- Existing CollegeOx visual identity and PR #6 larger typography remain.
- DMs are 1-to-1, text-only, immutable, non-deletable, with Seen, mute, typing, Online/Last seen.

---

### Task 1: Shared PR #8 runtime and route dispatcher

**Files:**
- Create: `src/pr8/index.js`
- Create: `src/pr8/common.js`
- Create: `src/pr8/event-hub.js`
- Modify: `package.json`
- Modify: `Dockerfile`
- Test: `tests/pr8-runtime.test.js`

**Interfaces:**
- Produces: `registerRoute(method, matcher, handler)`, `send(res,status,payload)`, `readBody(req,maxBytes)`, `requireUser(req)`, `emit(type,payload,targetUserIds)`, `subscribe(userId,res)`.
- Consumes: `require('../runtime-enhancements').db`.

- [ ] **Step 1: Write the failing runtime test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');

test('PR8 common router exports stable registration helpers', () => {
  const runtime = require('../src/pr8/index');
  assert.equal(typeof runtime.registerRoute, 'function');
  assert.equal(typeof runtime.emit, 'function');
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test tests/pr8-runtime.test.js`
Expected: FAIL because `src/pr8/index.js` does not exist.

- [ ] **Step 3: Implement the minimal dispatcher**

```js
const routes = [];
function registerRoute(method, matcher, handler) { routes.push({ method, matcher, handler }); }
async function dispatch(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const match = typeof route.matcher === 'string' ? route.matcher === url.pathname : url.pathname.match(route.matcher);
    if (match) return route.handler({ req, res, url, match });
  }
  return false;
}
module.exports = { registerRoute, dispatch };
```

Wire `package.json` and `Dockerfile` so PR #8 preloads after `runtime-enhancements.js` and before `static-enhancements.js`.

- [ ] **Step 4: Run the runtime test and the existing suite**

Run: `node --test tests/pr8-runtime.test.js && npm test`
Expected: PR8 runtime PASS and existing suite unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/pr8 package.json Dockerfile tests/pr8-runtime.test.js
git commit -m "Add modular campus suite runtime"
```

### Task 2: Forward-only schema for safety, presence, and DMs

**Files:**
- Modify: `src/db/migrations.js`
- Test: `tests/pr8-migrations.test.js`

**Interfaces:**
- Produces tables: `user_blocks`, `user_mutes`, `user_presence`, `dm_conversations`, `dm_messages`, `dm_settings`, `notification_preferences`.

- [ ] **Step 1: Write migration assertions**

```js
for (const name of ['user_blocks','user_mutes','user_presence','dm_conversations','dm_messages','dm_settings','notification_preferences']) {
  assert.ok(await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]));
}
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/pr8-migrations.test.js`
Expected: FAIL on missing version-4 tables.

- [ ] **Step 3: Add migration version 4**

Use composite uniqueness for the unordered DM pair by storing `user_low_id` and `user_high_id` and enforcing `UNIQUE(user_low_id,user_high_id)`. `dm_messages` has `seen_at` but no edit/delete columns. Add indexes for inbox ordering, unread messages, block lookup, and presence lookup.

- [ ] **Step 4: Verify fresh and upgraded databases**

Run: `node --test tests/pr8-migrations.test.js tests/app.test.js`
Expected: PASS on a fresh DB and an upgraded v3 fixture.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.js tests/pr8-migrations.test.js
git commit -m "Add messaging and safety schema"
```

### Task 3: Block, mute, and presence services

**Files:**
- Create: `src/pr8/safety.js`
- Create: `src/pr8/presence.js`
- Test: `tests/pr8-safety.test.js`

**Interfaces:**
- Produces: `isBlocked(a,b) -> Promise<boolean>`, `assertInteractionAllowed(a,b)`, `setMute(userId,targetType,targetId,muted)`, `touchPresence(userId)`, `presenceFor(userIds)`.

- [ ] **Step 1: Write failing behavior tests**

```js
assert.equal(await isBlocked(alice.id, bob.id), false);
await block(alice.id, bob.id);
assert.equal(await isBlocked(alice.id, bob.id), true);
await assert.rejects(() => assertInteractionAllowed(bob.id, alice.id), /blocked/i);
```

- [ ] **Step 2: Run failing test**

Run: `node --test tests/pr8-safety.test.js`
Expected: FAIL because services are missing.

- [ ] **Step 3: Implement symmetric interaction blocking and throttled presence writes**

`isBlocked(a,b)` checks either direction. Presence writes at most once per 60 seconds per process/user and returns `online` when last activity is within 90 seconds; otherwise it returns a timestamp used for relative Last seen.

- [ ] **Step 4: Run tests**

Run: `node --test tests/pr8-safety.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pr8/safety.js src/pr8/presence.js tests/pr8-safety.test.js
git commit -m "Add block mute and presence foundation"
```

### Task 4: Immutable 1-to-1 DM API

**Files:**
- Create: `src/pr8/dm.js`
- Test: `tests/pr8-dm.test.js`

**Interfaces:**
- Routes: `GET /api/dm/conversations`, `POST /api/dm/conversations`, `GET /api/dm/:id/messages`, `POST /api/dm/:id/messages`, `POST /api/dm/:id/seen`, `PATCH /api/dm/:id/settings`, `POST /api/dm/typing`.
- Emits: `dm_message`, `dm_seen`, `dm_typing`, `presence`, `notification_count`.

- [ ] **Step 1: Write failing API tests**

```js
const sent = await request(`/api/dm/${conversation.id}/messages`, {
  method: 'POST', headers: auth(alice), body: JSON.stringify({ body: 'hello' })
});
assert.equal(sent.response.status, 201);
assert.equal(sent.data.message.body, 'hello');
assert.equal(sent.data.message.seenAt, null);
```

Also assert no PATCH/DELETE message route exists, blocked users receive 403, Seen updates only messages sent by the other participant, and muted conversations remain readable but do not create push-eligible notification events.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test tests/pr8-dm.test.js`
Expected: FAIL on missing routes.

- [ ] **Step 3: Implement conversation canonicalization, pagination, send, seen, mute and typing**

Messages are ordered by `(created_at,id)` and use a composite cursor. Sending creates or reuses exactly one unordered conversation pair and updates `last_message_at` transactionally.

- [ ] **Step 4: Run DM and safety tests**

Run: `node --test tests/pr8-dm.test.js tests/pr8-safety.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pr8/dm.js tests/pr8-dm.test.js
git commit -m "Add one to one direct messages"
```

### Task 5: Messaging frontend

**Files:**
- Create: `public/pr8/app.js`
- Create: `public/pr8/dm.js`
- Create: `public/pr8/pr8.css`
- Modify: `src/static-enhancements.js`
- Test: `tests/pr8-static.test.js`

**Interfaces:**
- Adds route `messages` to the existing SPA navigation.
- Uses `api()` from existing `app.js` and a PR8 SSE helper exported by `public/pr8/app.js`.

- [ ] **Step 1: Write shell injection and syntax tests**

```js
const html = enhancedIndex();
assert.match(html, /\/pr8\/app\.js\?v=1/);
assert.match(html, /\/pr8\/pr8\.css\?v=1/);
```

- [ ] **Step 2: Run test and verify failure**

Run: `node --test tests/pr8-static.test.js`
Expected: FAIL because PR8 assets are not injected.

- [ ] **Step 3: Implement Messages UI**

Inbox shows avatar, name, latest message, unread count, mute state, Online/relative Last seen. Conversation view has immutable bubbles, Seen under the newest sent message, `@user is typing…`, and text composer only. Add Block and Mute controls. Do not add attachment/edit/delete controls.

- [ ] **Step 4: Verify syntax and shell**

Run: `node --check public/pr8/app.js && node --check public/pr8/dm.js && node --test tests/pr8-static.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/pr8 src/static-enhancements.js tests/pr8-static.test.js
git commit -m "Add direct messaging interface"
```
