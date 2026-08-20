# CollegeOx PR #7 — Campus Suite Design

Date: 2026-08-20
Branch: `agent/pr7-campus-suite`
Base: merged PR #6 feature head (`13d07f1e8f6253c57f01e1745f9a47edadf751e2`)

## Goal

PR #7 turns CollegeOx from a campus feed with clubs/projects/events into a broader campus network while preserving the current CollegeOx visual identity, Render Free deployment model, SQLite local development, PostgreSQL/Neon production database, existing privacy model, and current PR #6 features.

This remains one pull request as requested, but the implementation is split into focused backend and frontend modules. New features must not require a redesign of the existing shell, sidebar, colors, or card system. The slightly larger typography introduced in PR #6 remains the baseline.

## Non-goals

- No group DMs.
- No DM attachments, message editing, or message deletion.
- No payments or checkout system in Marketplace.
- No external recommendation/AI service.
- No mandatory third-party media provider for the first implementation.
- No required background worker or paid Render service.

## Architectural approach

The current monolithic `server.js` and browser `app.js` remain compatible, but PR #7 adds feature modules with explicit route registration/helpers rather than adding another large block to either file.

Proposed backend modules:

- `src/features/dm.js`
- `src/features/search.js`
- `src/features/social.js`
- `src/features/projects.js`
- `src/features/clubs.js`
- `src/features/campus.js`
- `src/features/notifications.js`
- `src/features/media.js`
- shared `src/features/common.js`

Proposed frontend modules:

- `public/features/dm.js`
- `public/features/search.js`
- `public/features/social.js`
- `public/features/campus.js`
- `public/features/profile.js`
- `public/features/notifications.js`
- `public/features/pr7.css`

The existing SSE channel remains the realtime transport. PostgreSQL and SQLite continue to share the same feature behavior. All schema changes are new forward-only migrations; migrations 1–3 are never rewritten.

## 1. Direct Messages

### Locked product decisions

- 1-to-1 conversations only.
- Any signed-in user can message any other non-blocked user.
- Text only.
- Messages cannot be edited.
- Messages cannot be deleted.
- Read receipts are enabled and show `Seen`.
- Conversations can be muted.
- Typing indicators are enabled.
- Everyone can see Online / Last seen.
- Last seen is relative: `Active 5 min ago`, `Active yesterday`, etc.

### Data model

- `dm_conversations`: unique unordered pair of participants, created time, last-message time.
- `dm_messages`: conversation, sender, immutable body, created time, seen time.
- `dm_settings`: per-user mute state for a conversation.
- `user_blocks`: blocker and blocked user.
- `user_presence`: last-seen timestamp.

Message content is immutable after insert. Typing state is ephemeral and sent over SSE; it is not stored in the database. Presence writes are throttled so routine page activity does not produce excessive PostgreSQL writes.

Blocking prevents new DMs, follows, reactions/comments targeted at the blocker, and removes blocked users from discovery/recommendation surfaces. Existing DM history remains visible to the participant who has not deleted their account.

### API/UI

- Inbox list with latest message, unread count, mute state, presence.
- Conversation view with chronological pagination.
- Send message endpoint.
- Seen endpoint when conversation becomes visible.
- Mute/unmute and block/unblock endpoints.
- SSE events: `dm_message`, `dm_seen`, `dm_typing`, `presence`.

## 2. Global Search and Discovery

The global search bar updates live while typing with a short debounce. Tabs:

`All | People | Posts | Clubs | Projects | Events | Marketplace | Lost & Found`

`All` uses relevance ranking rather than newest-first. Ranking is deterministic and database-portable: exact match > prefix match > word/tag/skill match > contains match, with a small recency component for content. No Postgres-only full-text feature is required.

Private profiles and their private activity remain excluded. Block relationships are respected in both directions.

## 3. Project Applications and Project Roles

Every project uses applications; ordinary users no longer join instantly.

Flow:

`Apply with message (max 300 chars) -> Pending -> Owner reviews -> Accept / Reject`

Accepting is transaction-safe and checks current capacity at the moment of acceptance.

Project roles:

- Lead (owner)
- Developer
- Designer
- Researcher
- Member

The owner can assign a role after acceptance. Ownership transfer continues to work and promotes the new owner to Lead.

Project updates use context-linked posts, so updates can receive normal reactions/comments/mentions and can appear on the project page without duplicating post logic.

## 4. Club Membership Modes and Club Roles

Each club chooses one join mode:

- `open`: instant join.
- `approval`: join request with optional message up to 300 characters; owner/admin accepts or rejects.
- `invite`: only invited users can join.

Club roles:

- Owner
- Admin
- Moderator
- Member

Owner/Admin can handle membership requests and invites. Moderator can moderate club content but cannot transfer ownership or change the owner's role.

Clubs can create context-linked posts and club events. The existing live club chat stays separate from club posts.

## 5. Poll Posts

Polls are a post type and support:

- single-choice or multiple-choice voting;
- creator-selected anonymous or public voter visibility;
- mandatory creator-selected expiry time;
- immutable options once voting has started;
- results remain visible after expiry.

Anonymous polls never expose voter identities through normal APIs. Management access does not automatically expose anonymous votes because anonymity is a product promise, not only a UI choice.

## 6. Mentions, Hashtags and Context Posts

`@username` mentions in posts, comments, project updates, club posts, and club chat messages become clickable and notify the mentioned user, unless the mention is blocked or self-directed.

Hashtags are parsed and indexed when content is written. Clicking `#robotics` opens a hashtag page containing allowed matching posts plus related projects, clubs, and events.

A `post_contexts` relation links regular posts to optional club/project contexts. This keeps one post/reaction/comment system while allowing club posts and project updates.

## 7. Pinned Posts

Locked choice: one pin per context.

- A user may pin one of their own posts on their profile.
- A club may pin one club-context post.
- A project may pin one project-context post/update.

Replacing the pin is atomic and does not alter or duplicate the underlying post.

## 8. Post Images

Posts may include 1–4 images. The browser compresses images before upload (WebP where supported), with a strict total payload ceiling. Images are stored through a media abstraction.

For PR #7 the default provider is database-backed so the app remains deployable without a new service. Media rows are separated from posts and are deleted with their parent content. The abstraction is intentionally shaped so an object-storage provider can replace database media later without changing post APIs.

UI includes thumbnail layout and fullscreen viewer. DMs remain text-only.

## 9. User Block and Mute

Block is strong and symmetric for interaction surfaces:

- no new DMs;
- no follows;
- no reactions/comments directed across the block;
- users are hidden from each other's search/recommendations/feed where practical;
- profile access returns a neutral unavailable state.

Mute is local and non-destructive. Users can mute:

- another user's feed activity;
- a club's feed activity;
- a DM conversation;
- notification categories.

Muted users are not informed.

## 10. Profile Expansion

Profiles gain tabs:

`About | Posts | Projects | Clubs | Events`

Profiles also gain:

- normalized Skills;
- `Available for projects` toggle;
- pinned post;
- existing interests and links.

Skill data participates in project discovery and recommendations.

## 11. Recommendations

Recommendations are explainable heuristics computed from stored campus data, not AI profiling.

People ranking uses combinations of shared department, shared interests/skills, mutual follows, and shared memberships. Club/project ranking uses interests, skills, department relevance, and existing membership overlap.

Recommendations always obey profile privacy, archive state, block state, and capacity/join restrictions.

## 12. Trending

Trending is calculated from recent campus activity, primarily the last seven days:

- hashtag usage;
- reactions;
- comments;
- unique participants;
- recency decay.

It returns a short campus trends section rather than a permanent leaderboard.

## 13. Marketplace

Marketplace supports:

- Sell
- Buy
- Borrow
- Give away

Listings include title, description, category, condition where relevant, optional INR price, location text, optional compressed image, created/expiry time, and status (`active`, `reserved`, `sold`, `closed`, `expired`).

CollegeOx does not process payments. Contact happens through 1-to-1 DMs. Owners can close or mark listings sold/reserved. Expired listings disappear from normal search but remain visible to their owner.

## 14. Lost & Found

Separate section with statuses:

- Lost
- Found
- Returned

Entries include item name, description, approximate location, date, optional compressed image, and owner/reporter. Contact uses DMs. Returned items leave the active feed but remain in the reporter's history.

## 15. Campus Q&A

Questions support answers, answer upvotes, and one accepted answer selected by the question author.

Questions may be posted anonymously. Anonymous means the public API/UI hides the author's identity, but the author ID is retained for abuse prevention and is visible to owner/management moderation tools. Answers are always attributed.

Q&A supports hashtags/mentions where appropriate and appears in global search through the All results without adding another top-level search tab in PR #7.

## 16. Bookmark Collections

Saved posts gain optional user-created collections such as `Study`, `Projects`, or `Read later`.

A saved post can belong to multiple collections. The existing Saved feed remains available and represents all saved posts regardless of collection.

## 17. Event Calendar and Reminders

Events gain month and agenda views in addition to cards. Club events use the same event model with optional club context.

Users can set reminders such as 1 hour, 1 day, or custom allowed presets before an event. Reminder records are idempotent and generate the existing notification format.

Because Render Free may sleep when idle, PR #7 guarantees reminders when the app/server is active and also performs catch-up reminder generation when a user reconnects. Closed-app push delivery during Render sleep is best-effort, not guaranteed without an external scheduler.

## 18. Push Notifications

PWA push is optional per user. Browser push subscriptions are stored in PostgreSQL/SQLite. The server uses VAPID keys when configured.

If VAPID configuration is absent or the browser denies permission, all features continue with in-app notifications only. Push is never required for sign-in or core functionality.

Push-eligible categories include DMs, mentions, application decisions, club membership decisions, event reminders, and official announcements. Users can disable categories.

## 19. Onboarding

New accounts receive a lightweight onboarding sequence after registration:

1. Department/year
2. Interests
3. Skills
4. Project availability
5. Suggested people/clubs/projects to follow/join/apply

Existing accounts are not forced through onboarding. They can edit all onboarding fields later from Profile/Settings.

## 20. Notification Expansion

The current notification table remains the base. PR #7 adds notification categories/settings and events for:

- DM messages
- mentions
- project application received/accepted/rejected
- club request/invite/decision
- event reminder/change/cancellation
- poll activity where useful
- marketplace/lost-and-found contact flows only through DM, avoiding duplicate notification spam

Self-notifications are suppressed and repeated events are deduplicated where a stable entity/action key exists.

## 21. Privacy and Safety Rules

- Private profiles remain absent from directory/search/recommendations.
- Private-profile activity does not leak into global feeds/search.
- Blocks override follow, recommendation, DM, and interaction behavior.
- Anonymous Q&A authors are hidden publicly but moderation can identify them.
- Anonymous poll voter identities are not exposed through management APIs.
- Report/moderation tools from PR #6 remain compatible with new content types; report targets expand to marketplace, lost/found, Q&A and DM conversation metadata where appropriate, but management never receives arbitrary private DM contents merely because a report exists. A reporter may explicitly attach selected message IDs when reporting a DM.

## 22. Schema Plan

New migrations begin at version 4 and are grouped by subsystem rather than one enormous SQL string.

Expected tables/relations include:

- DM: `dm_conversations`, `dm_messages`, `dm_settings`, `user_blocks`, `user_presence`
- Discovery/profile: `user_skills`, `user_preferences`, `user_mutes`
- Projects: `project_applications`, `project_member_roles`
- Clubs: `club_membership_requests`, `club_invites`, `club_member_roles`
- Social: `polls`, `poll_options`, `poll_votes`, `mentions`, `hashtags`, `content_hashtags`, `post_contexts`, `pinned_posts`, `bookmark_collections`, `bookmark_collection_posts`
- Media: `media`, `post_media`
- Campus: `marketplace_listings`, `lost_found_entries`, `questions`, `answers`, `answer_votes`
- Events/notifications: `event_reminders`, `push_subscriptions`, `notification_preferences`

Indexes must cover conversation pagination, unread messages, live search terms, pending applications/requests, active listings, hashtag lookups, reminder due times, and notification/user lookups.

## 23. Realtime Design

SSE remains the only required realtime transport. The feature layer publishes domain events through one shared event hub rather than each module inventing its own connection handling.

Realtime events include:

- DM message/seen/typing
- presence changes
- application/request decisions
- relevant notification count changes
- poll result changes
- club/project membership changes
- existing post/event/club updates

A client that misses SSE events must recover from normal API refresh; SSE is an acceleration layer, never the source of truth.

## 24. Error Handling and Transactions

All state-changing endpoints:

- validate authorization and block/privacy rules server-side;
- use transactions for capacity/application acceptance, poll voting, ownership/membership changes, and multi-row writes;
- return stable 4xx errors for expected conflicts;
- avoid partial writes if notification/media/index updates fail;
- treat push delivery as best-effort and never roll back core data because push failed.

PostgreSQL uses row locks where concurrency can oversubscribe capacity. SQLite relies on serialized transactions.

## 25. UI Design

No full redesign.

- Keep existing cream/white/blue/yellow CollegeOx identity.
- Keep sidebar and responsive layout.
- Keep PR #6's slightly larger text sizes.
- Add new sidebar entries only where a feature deserves a destination: Messages, Marketplace, Lost & Found, Q&A.
- Search remains in the global header.
- Profiles use tabs within the existing profile page.
- Calendar toggles inside Events rather than creating a second navigation destination.
- Mobile keeps the existing responsive behavior and dialogs become full-height sheets where necessary.

## 26. Testing Strategy

Every subsystem gets API-level regression tests on SQLite. Tests cover both happy paths and permission/privacy failures.

Required suites include:

- immutable 1-to-1 DMs, unread/seen, mute, block, presence
- live search relevance and privacy
- project application capacity and acceptance races
- club join modes/invites/roles
- poll single/multiple voting, visibility, expiry
- mentions/hashtag indexing and notification suppression
- pin replacement and context ownership
- image count/size/ownership cleanup
- block/mute behavior across feeds/search/interactions
- recommendations respecting privacy/block/archive/capacity
- marketplace and lost/found lifecycle
- anonymous Q&A identity hiding and moderation visibility
- accepted answer/upvote rules
- bookmark collections
- event reminders and catch-up generation
- push failure not affecting core notification writes
- onboarding only for new users
- existing PR #6 tests unchanged and passing

PostgreSQL-specific transaction behavior should get a small integration test path when `DATABASE_URL` is available. The normal test suite must remain runnable without PostgreSQL.

## 27. Delivery Order Inside One PR

Although this ships as one PR, commits should be reviewable in this order:

1. migrations + shared feature infrastructure
2. block/mute/presence foundation
3. DMs
4. search/profile/skills/onboarding
5. project applications/roles/updates
6. club join modes/roles/events
7. polls/mentions/hashtags/pins/bookmark collections
8. post/media support
9. marketplace/lost & found/Q&A
10. recommendations/trending
11. calendar/reminders/push notifications
12. frontend integration/readability/responsive polish
13. complete regression suite and final deployment/cache verification

## Acceptance criteria

PR #7 is ready for review only when:

- all existing tests pass;
- all new feature regression tests pass;
- migrations work on a fresh SQLite database and an upgraded v3 database;
- production startup still works with `DATABASE_URL` and no optional push configuration;
- no feature requires a paid Render disk/background worker;
- private-profile and block rules are enforced server-side;
- DMs obey all locked choices;
- global search includes Marketplace and Lost & Found and ranks All by relevance;
- every project uses applications with a 300-character message;
- clubs support open/approval/invite modes with approval messages;
- polls support single/multiple, creator-selected public/anonymous visibility, and mandatory expiry;
- mentions notify and link; hashtag pages include related entities;
- each user/club/project supports exactly one pinned post;
- the original CollegeOx UI identity remains recognizable and fonts are not made smaller.
