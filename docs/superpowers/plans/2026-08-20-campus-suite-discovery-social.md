# Campus Suite Discovery and Social Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live global search, profile skills/onboarding, recommendations/trending, polls, mentions, hashtags, pinned posts, bookmark collections, and post images.

**Architecture:** Build on the PR #8 dispatcher and shared database/event hub from the foundation plan. Search remains database-portable; social features reuse the existing post model through side tables and context relations instead of replacing posts.

**Tech Stack:** Node.js 24, SQLite, PostgreSQL, vanilla JS/CSS, SSE.

**Spec:** `docs/superpowers/specs/2026-08-20-pr7-campus-suite-design.md`

## Global Constraints

- Search must respect private profiles and blocks server-side.
- `All` search is ranked by relevance.
- Polls support single/multiple choice, creator-selected anonymous/public votes, mandatory expiry.
- Mentions notify and link; hashtags connect posts plus related clubs/projects/events.
- Exactly one pinned post per user/club/project context.
- Images are compressed client-side; DMs remain text-only.

---

### Task 1: Discovery and social schema

**Files:**
- Modify: `src/db/migrations.js`
- Test: `tests/pr8-social-migrations.test.js`

**Interfaces:**
- Produces: `user_skills`, `user_preferences`, `polls`, `poll_options`, `poll_votes`, `mentions`, `hashtags`, `content_hashtags`, `post_contexts`, `pinned_posts`, `bookmark_collections`, `bookmark_collection_posts`, `media`, `post_media`.

- [ ] **Step 1: Write failing table/index assertions**

```js
for (const name of ['user_skills','polls','poll_options','poll_votes','mentions','hashtags','content_hashtags','post_contexts','pinned_posts','bookmark_collections','media','post_media']) {
  assert.ok(await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]));
}
```

- [ ] **Step 2: Run test and verify failure**

Run: `node --test tests/pr8-social-migrations.test.js`
Expected: FAIL on missing tables.

- [ ] **Step 3: Add migrations 5 and 6**

Use one migration for profile/discovery and one for social/media. `pinned_posts` stores `context_type`, `context_id`, `post_id` with a unique `(context_type,context_id)`. `poll_votes` stores one row per `(poll_id,user_id,option_id)` and the service enforces single-choice polls transactionally.

- [ ] **Step 4: Run migration tests**

Run: `node --test tests/pr8-social-migrations.test.js tests/pr8-migrations.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.js tests/pr8-social-migrations.test.js
git commit -m "Add discovery and social schema"
```

### Task 2: Live global search

**Files:**
- Create: `src/pr8/search.js`
- Create: `public/pr8/search.js`
- Test: `tests/pr8-search.test.js`

**Interfaces:**
- Route: `GET /api/search?q=&type=all|people|posts|clubs|projects|events|marketplace|lostfound&limit=`.
- Produces normalized result `{type,id,title,subtitle,snippet,score,createdAt}`.

- [ ] **Step 1: Write relevance/privacy tests**

```js
const results = await api('/api/search?q=robotics&type=all');
assert.equal(results.items[0].score >= results.items.at(-1).score, true);
assert.equal(results.items.some(item => item.id === privateUser.id), false);
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/pr8-search.test.js`
Expected: FAIL on missing endpoint.

- [ ] **Step 3: Implement portable ranking**

Use lowercase exact/prefix/contains scoring in SQL/JS and a small recency term. Query each permitted source with a bounded limit, normalize, merge, sort, and trim. Exclude private profiles/activity and both directions of blocks.

- [ ] **Step 4: Add debounced frontend tabs**

`public/pr8/search.js` debounces input by 180 ms, cancels stale renders with a monotonically increasing request token, and renders `All | People | Posts | Clubs | Projects | Events | Marketplace | Lost & Found`.

- [ ] **Step 5: Verify and commit**

Run: `node --check public/pr8/search.js && node --test tests/pr8-search.test.js`
Expected: PASS.

```bash
git add src/pr8/search.js public/pr8/search.js tests/pr8-search.test.js
git commit -m "Add live global campus search"
```

### Task 3: Skills, project availability, profile tabs, onboarding

**Files:**
- Create: `src/pr8/profile.js`
- Create: `public/pr8/profile.js`
- Test: `tests/pr8-profile.test.js`

**Interfaces:**
- Routes: `GET/PATCH /api/profile/preferences`, `GET/PATCH /api/profile/skills`, `GET /api/profiles/:username/summary`, `POST /api/onboarding/complete`.

- [ ] **Step 1: Write onboarding/profile tests**

```js
assert.equal(newUser.onboardingComplete, false);
await patch('/api/profile/skills', { skills: ['PCB Design','JavaScript'] });
const profile = await get(`/api/profiles/${newUser.username}/summary`);
assert.deepEqual(profile.skills, ['JavaScript','PCB Design']);
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/pr8-profile.test.js`
Expected: FAIL on missing endpoints.

- [ ] **Step 3: Implement normalized skills and preferences**

Store skills case-insensitively with a normalized key and display label. Preferences include `available_for_projects`, `onboarding_complete`, and notification/mute defaults. Existing users default to completed onboarding; newly registered accounts are marked incomplete by the PR8 registration hook.

- [ ] **Step 4: Implement profile tabs and onboarding sheet**

Tabs: `About | Posts | Projects | Clubs | Events`. New users get the five-step onboarding flow from the spec; all fields stay editable later.

- [ ] **Step 5: Verify and commit**

Run: `node --check public/pr8/profile.js && node --test tests/pr8-profile.test.js`
Expected: PASS.

```bash
git add src/pr8/profile.js public/pr8/profile.js tests/pr8-profile.test.js
git commit -m "Add profile skills tabs and onboarding"
```

### Task 4: Polls, mentions, hashtags, contexts and pins

**Files:**
- Create: `src/pr8/social.js`
- Create: `public/pr8/social.js`
- Test: `tests/pr8-social.test.js`

**Interfaces:**
- Routes: `POST /api/polls`, `POST /api/polls/:id/vote`, `GET /api/polls/:id`, `GET /api/hashtags/:tag`, `PUT /api/pins/:contextType/:contextId`.
- Helper: `indexTextMentionsAndHashtags({kind,entityId,authorId,text})`.

- [ ] **Step 1: Write poll and indexing tests**

```js
assert.equal((await vote(singlePoll, user, [a.id])).response.status, 200);
assert.equal((await vote(singlePoll, user, [a.id,b.id])).response.status, 400);
assert.equal((await get(`/api/hashtags/robotics`)).posts.length > 0, true);
```

Also assert anonymous poll APIs omit voter identities and expired polls reject new votes.

- [ ] **Step 2: Run failing tests**

Run: `node --test tests/pr8-social.test.js`
Expected: FAIL on missing routes.

- [ ] **Step 3: Implement transaction-safe voting and text indexing**

Create poll and options in one transaction. Voting deletes/replaces the current user's selection only when the poll is open. Mentions resolve usernames at write time and suppress self/blocked notifications. Hashtags are normalized lowercase without `#`.

- [ ] **Step 4: Implement one-pin-per-context and hashtag pages**

Validate that profile pins belong to the user and club/project pins belong to the matching context and are controlled by owner/admin rules.

- [ ] **Step 5: Verify and commit**

Run: `node --check public/pr8/social.js && node --test tests/pr8-social.test.js`
Expected: PASS.

```bash
git add src/pr8/social.js public/pr8/social.js tests/pr8-social.test.js
git commit -m "Add polls mentions hashtags and pins"
```

### Task 5: Bookmark collections and post images

**Files:**
- Create: `src/pr8/media.js`
- Create: `public/pr8/media.js`
- Modify: `src/pr8/social.js`
- Test: `tests/pr8-media-bookmarks.test.js`

**Interfaces:**
- Routes: `GET/POST /api/bookmark-collections`, `PUT/DELETE /api/bookmark-collections/:id/posts/:postId`, `POST /api/posts/:id/media`, `GET /api/media/:id`.

- [ ] **Step 1: Write collection/media tests**

```js
assert.equal((await addSavedPostToCollection(collection.id, post.id)).response.status, 200);
assert.equal((await uploadMedia(post.id, fiveImages)).response.status, 400);
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/pr8-media-bookmarks.test.js`
Expected: FAIL on missing routes.

- [ ] **Step 3: Implement collections and media abstraction**

Collections are per-user and a post may belong to multiple collections. Media accepts only image MIME types, maximum four images per post, and a strict total compressed payload ceiling. Store bytes/data in `media` with provider `database` and keep API shape provider-neutral.

- [ ] **Step 4: Implement browser compression/viewer**

Resize each image to a maximum 1600px long edge, encode WebP when supported, reduce quality until within the per-image budget, render 1-4 thumbnail layouts, and provide a fullscreen dialog viewer.

- [ ] **Step 5: Verify and commit**

Run: `node --check public/pr8/media.js && node --test tests/pr8-media-bookmarks.test.js`
Expected: PASS.

```bash
git add src/pr8/media.js src/pr8/social.js public/pr8/media.js tests/pr8-media-bookmarks.test.js
git commit -m "Add bookmark collections and post images"
```

### Task 6: Recommendations and trending

**Files:**
- Create: `src/pr8/discovery.js`
- Create: `public/pr8/discovery.js`
- Test: `tests/pr8-discovery.test.js`

**Interfaces:**
- Routes: `GET /api/discovery/people`, `GET /api/discovery/clubs`, `GET /api/discovery/projects`, `GET /api/trending`.

- [ ] **Step 1: Write explainability/privacy tests**

```js
const item = (await get('/api/discovery/people')).items[0];
assert.ok(item.reason);
assert.equal(item.id === blockedUser.id, false);
```

- [ ] **Step 2: Run failing tests**

Run: `node --test tests/pr8-discovery.test.js`
Expected: FAIL on missing routes.

- [ ] **Step 3: Implement deterministic heuristics**

Score people by shared department, interests, skills, mutual follows, shared memberships. Score clubs/projects by interest/skill match, department relevance, membership overlap, archive/capacity status. Trending uses seven-day hashtag usage + reactions + comments + unique participants with recency decay.

- [ ] **Step 4: Render compact recommendation/trending cards**

Keep them within current CollegeOx rail/card visual language and never hide core feed content behind recommendations.

- [ ] **Step 5: Verify and commit**

Run: `node --check public/pr8/discovery.js && node --test tests/pr8-discovery.test.js`
Expected: PASS.

```bash
git add src/pr8/discovery.js public/pr8/discovery.js tests/pr8-discovery.test.js
git commit -m "Add campus recommendations and trending"
```
