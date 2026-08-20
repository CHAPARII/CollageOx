# Campus Suite Communities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace instant project joins with applications, add project roles/updates, and add configurable club join modes, invites, roles, and club events.

**Architecture:** Extend existing project/club records using side tables and focused PR #8 routers. Capacity-sensitive acceptance uses transactions and PostgreSQL row locks. Existing ownership transfer/status/chat behavior remains compatible.

**Tech Stack:** Node.js 24, SQLite, PostgreSQL, vanilla JS/CSS, SSE.

**Spec:** `docs/superpowers/specs/2026-08-20-pr7-campus-suite-design.md`

## Global Constraints

- Every project uses applications with a message up to 300 characters.
- Project acceptance checks capacity at acceptance time.
- Club join modes are open, approval, invite-only.
- Approval requests may include a 300-character message.
- Club roles: Owner, Admin, Moderator, Member.
- Project roles: Lead, Developer, Designer, Researcher, Member.

---

### Task 1: Project and club workflow schema

**Files:**
- Modify: `src/db/migrations.js`
- Test: `tests/pr8-community-migrations.test.js`

**Interfaces:**
- Produces: `project_applications`, `project_member_roles`, `club_membership_requests`, `club_invites`, `club_member_roles`, `club_join_settings`.

- [ ] **Step 1: Write failing schema assertions**

```js
for (const name of ['project_applications','project_member_roles','club_membership_requests','club_invites','club_member_roles','club_join_settings']) {
  assert.ok(await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]));
}
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/pr8-community-migrations.test.js`
Expected: FAIL on missing migration tables.

- [ ] **Step 3: Add version-7 community migration**

Applications/requests use explicit statuses `pending|accepted|rejected|cancelled`; enforce one active pending row per user/context in service logic. Add indexes for pending owner queues and member roles.

- [ ] **Step 4: Run migration tests**

Run: `node --test tests/pr8-community-migrations.test.js tests/pr8-migrations.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.js tests/pr8-community-migrations.test.js
git commit -m "Add project and club workflow schema"
```

### Task 2: Mandatory project applications

**Files:**
- Create: `src/pr8/projects.js`
- Create: `public/pr8/projects.js`
- Test: `tests/pr8-project-applications.test.js`

**Interfaces:**
- Routes: `POST /api/projects/:id/applications`, `GET /api/projects/:id/applications`, `PATCH /api/projects/:id/applications/:applicationId`, `PATCH /api/projects/:id/members/:userId/role`.

- [ ] **Step 1: Write failing application tests**

```js
const applied = await post(`/api/projects/${project.id}/applications`, { message: 'I can help with PCB design.' });
assert.equal(applied.response.status, 201);
assert.equal(applied.data.application.status, 'pending');
```

Also assert duplicate pending applications return 409, message length >300 returns 400, non-owner cannot review, and accepting a full project returns 409 without adding membership.

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/pr8-project-applications.test.js`
Expected: FAIL on missing endpoints.

- [ ] **Step 3: Implement application service and transaction-safe acceptance**

On PostgreSQL lock the project row with `FOR UPDATE`, recount current members, insert membership only when below capacity, set default role `Member`, and update application status in the same transaction. SQLite uses the existing serialized transaction wrapper.

- [ ] **Step 4: Replace instant Join UI with Apply flow**

Project cards show `Apply`, `Application pending`, `Joined`, or `Owner`. Application dialog has a 300-character message. Owners get an Applications panel with Accept/Reject controls and member-role selectors.

- [ ] **Step 5: Verify and commit**

Run: `node --check public/pr8/projects.js && node --test tests/pr8-project-applications.test.js`
Expected: PASS.

```bash
git add src/pr8/projects.js public/pr8/projects.js tests/pr8-project-applications.test.js
git commit -m "Add project application workflow"
```

### Task 3: Project roles, ownership, updates and pin integration

**Files:**
- Modify: `src/pr8/projects.js`
- Modify: `public/pr8/projects.js`
- Modify: `src/pr8/social.js`
- Test: `tests/pr8-project-roles.test.js`

**Interfaces:**
- Roles: `Lead|Developer|Designer|Researcher|Member`.
- Context posts use `post_contexts(context_type='project', context_id=projectId)`.

- [ ] **Step 1: Write role/ownership tests**

```js
await patch(`/api/projects/${project.id}/members/${member.id}/role`, { role: 'Designer' });
const roster = await get(`/api/projects/${project.id}/members`);
assert.equal(roster.members.find(x => x.id === member.id).projectRole, 'Designer');
```

Assert ownership transfer makes new owner `Lead` and the previous owner remains a member unless removed later by normal membership rules.

- [ ] **Step 2: Run failing tests**

Run: `node --test tests/pr8-project-roles.test.js`
Expected: FAIL on missing role/context behavior.

- [ ] **Step 3: Implement role validation and context updates**

Project updates are normal posts with a project context. Reuse reactions/comments/mentions/pin APIs. Only project owner/Lead may assign roles and pin project posts.

- [ ] **Step 4: Add project page sections**

Render Overview, Updates, Members, Applications for owners. Show role chips and the pinned update at the top.

- [ ] **Step 5: Verify and commit**

Run: `node --check public/pr8/projects.js && node --test tests/pr8-project-roles.test.js`
Expected: PASS.

```bash
git add src/pr8/projects.js src/pr8/social.js public/pr8/projects.js tests/pr8-project-roles.test.js
git commit -m "Add project roles and updates"
```

### Task 4: Club join modes and requests

**Files:**
- Create: `src/pr8/clubs.js`
- Create: `public/pr8/clubs.js`
- Test: `tests/pr8-club-membership.test.js`

**Interfaces:**
- Routes: `PATCH /api/clubs/:id/join-settings`, `POST /api/clubs/:id/join`, `GET /api/clubs/:id/requests`, `PATCH /api/clubs/:id/requests/:requestId`, `POST /api/clubs/:id/invites`.

- [ ] **Step 1: Write join-mode tests**

```js
await patch(`/api/clubs/${club.id}/join-settings`, { mode: 'approval' });
const request = await post(`/api/clubs/${club.id}/join`, { message: 'I would like to help.' });
assert.equal(request.data.status, 'pending');
```

Assert open mode joins immediately, invite mode rejects uninvited users, accepted invite joins once, and approval message >300 returns 400.

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/pr8-club-membership.test.js`
Expected: FAIL on missing routes.

- [ ] **Step 3: Implement join settings/request/invite services**

Use transaction-safe membership creation and idempotent invites. Owner/Admin can review requests; Moderator cannot change join settings or issue ownership-level actions.

- [ ] **Step 4: Add club membership UI**

Club cards/pages show join mode. Approval mode opens a message dialog. Invite-only shows `Invite only`. Owner/Admin management view shows pending requests and invite-by-username.

- [ ] **Step 5: Verify and commit**

Run: `node --check public/pr8/clubs.js && node --test tests/pr8-club-membership.test.js`
Expected: PASS.

```bash
git add src/pr8/clubs.js public/pr8/clubs.js tests/pr8-club-membership.test.js
git commit -m "Add configurable club membership"
```

### Task 5: Club roles, context posts, and club events

**Files:**
- Modify: `src/pr8/clubs.js`
- Modify: `public/pr8/clubs.js`
- Modify: `src/pr8/social.js`
- Test: `tests/pr8-club-roles-events.test.js`

**Interfaces:**
- Roles: `Owner|Admin|Moderator|Member`.
- Club events reuse existing `events` with optional club context relation stored in a PR8 side table or the general content-context relation.

- [ ] **Step 1: Write authorization tests**

```js
assert.equal((await assignClubRole(owner, moderator.id, 'Moderator')).response.status, 200);
assert.equal((await assignClubRole(moderator, member.id, 'Admin')).response.status, 403);
```

Also assert only Owner/Admin create club events, club members can see club-context posts according to club status, and pinned club posts must belong to that club context.

- [ ] **Step 2: Run failing tests**

Run: `node --test tests/pr8-club-roles-events.test.js`
Expected: FAIL on missing role/event integration.

- [ ] **Step 3: Implement role matrix and event context**

Owner controls role changes and ownership. Admin manages requests/invites/events/content. Moderator can moderate club content/chat but cannot promote users or transfer ownership. Member has normal participation rights.

- [ ] **Step 4: Add club page tabs**

Render Posts, Chat, Events, Members with management controls only where authorized. Preserve existing live club chat.

- [ ] **Step 5: Verify and commit**

Run: `node --check public/pr8/clubs.js && node --test tests/pr8-club-roles-events.test.js`
Expected: PASS.

```bash
git add src/pr8/clubs.js src/pr8/social.js public/pr8/clubs.js tests/pr8-club-roles-events.test.js
git commit -m "Add club roles posts and events"
```
