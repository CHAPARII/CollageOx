const migrations = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL, email TEXT, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student', bio TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '', year TEXT NOT NULL DEFAULT '', pronouns TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL DEFAULT '', accent TEXT NOT NULL DEFAULT '#155eef', interests TEXT NOT NULL DEFAULT '[]', links TEXT NOT NULL DEFAULT '[]', profile_visibility TEXT NOT NULL DEFAULT 'campus', created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci ON users(LOWER(username));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_ci ON users(LOWER(email)) WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS follows (follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, following_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(follower_id,following_id));
CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, type TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, edited_at TEXT);
CREATE TABLE IF NOT EXISTS reactions (post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, PRIMARY KEY(post_id,user_id));
CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, pitch TEXT NOT NULL, skills TEXT NOT NULL DEFAULT '[]', capacity INTEGER NOT NULL DEFAULT 4, status TEXT NOT NULL DEFAULT 'recruiting', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_members (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, joined_at TEXT NOT NULL, PRIMARY KEY(project_id,user_id));
CREATE TABLE IF NOT EXISTS clubs (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, accent TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clubs_name_ci ON clubs(LOWER(name));
CREATE TABLE IF NOT EXISTS club_members (club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, joined_at TEXT NOT NULL, PRIMARY KEY(club_id,user_id));
CREATE TABLE IF NOT EXISTS club_messages (id TEXT PRIMARY KEY, club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE, author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT NOT NULL, starts_at TEXT NOT NULL, location TEXT NOT NULL, capacity INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS event_attendees (event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, joined_at TEXT NOT NULL, PRIMARY KEY(event_id,user_id));
CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, body TEXT NOT NULL, audience TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, subject TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', admin_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id,created_at);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
CREATE INDEX IF NOT EXISTS idx_club_messages_club ON club_messages(club_id,created_at);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status,created_at DESC);
`
  },
  {
    version: 2,
    name: 'feature_hardening',
    sql: `
CREATE TABLE IF NOT EXISTS saved_posts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,post_id)
);
CREATE TABLE IF NOT EXISTS issue_messages (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS club_settings (
  club_id TEXT PRIMARY KEY REFERENCES clubs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS role_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_role TEXT NOT NULL,
  to_role TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saved_posts_user ON saved_posts(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_issue_messages_issue ON issue_messages(issue_id,created_at);
CREATE INDEX IF NOT EXISTS idx_role_audit_user ON role_audit(user_id,created_at DESC);
`
  },
  {
    version: 3,
    name: 'stability_and_core_features',
    sql: `
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  review_note TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id,read_at,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type,target_id);
`
  },
  {
    version: 4,
    name: 'campus_suite_messaging_safety',
    sql: `
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(blocker_id,blocked_id)
);
CREATE TABLE IF NOT EXISTS user_mutes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,target_type,target_id)
);
CREATE TABLE IF NOT EXISTS user_presence (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_conversations (
  id TEXT PRIMARY KEY,
  user_low_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_message_at TEXT NOT NULL,
  UNIQUE(user_low_id,user_high_id)
);
CREATE TABLE IF NOT EXISTS dm_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  seen_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_settings (
  conversation_id TEXT NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id,user_id)
);
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(user_id,category)
);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id,blocker_id);
CREATE INDEX IF NOT EXISTS idx_user_mutes_target ON user_mutes(user_id,target_type,target_id);
CREATE INDEX IF NOT EXISTS idx_presence_last_seen ON user_presence(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_pair ON dm_conversations(user_low_id,user_high_id);
CREATE INDEX IF NOT EXISTS idx_dm_inbox_low ON dm_conversations(user_low_id,last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_inbox_high ON dm_conversations(user_high_id,last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_messages_page ON dm_messages(conversation_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_dm_unread ON dm_messages(conversation_id,sender_id,seen_at,created_at DESC);
`
  },
  {
    version: 5,
    name: 'campus_suite_profile_discovery',
    sql: `
CREATE TABLE IF NOT EXISTS user_skills (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  normalized TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,normalized)
);
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available_for_projects INTEGER NOT NULL DEFAULT 0,
  onboarding_complete INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
INSERT INTO user_preferences (user_id,available_for_projects,onboarding_complete,updated_at)
SELECT id,0,1,created_at FROM users
WHERE id NOT IN (SELECT user_id FROM user_preferences);
CREATE INDEX IF NOT EXISTS idx_user_skills_normalized ON user_skills(normalized,user_id);
CREATE INDEX IF NOT EXISTS idx_user_preferences_available ON user_preferences(available_for_projects,user_id);
`
  },
  {
    version: 6,
    name: 'campus_suite_social_media',
    sql: `
CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
  choice_mode TEXT NOT NULL,
  voter_visibility TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(poll_id,option_id,user_id)
);
CREATE TABLE IF NOT EXISTS mentions (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  mentioned_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE(source_type,source_id,mentioned_user_id)
);
CREATE TABLE IF NOT EXISTS hashtags (
  tag TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS content_hashtags (
  tag TEXT NOT NULL REFERENCES hashtags(tag) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(tag,source_type,source_id)
);
CREATE TABLE IF NOT EXISTS post_contexts (
  post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  context_type TEXT NOT NULL,
  context_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pinned_posts (
  context_type TEXT NOT NULL,
  context_id TEXT NOT NULL,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  pinned_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(context_type,context_id)
);
CREATE TABLE IF NOT EXISTS bookmark_collections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id,name)
);
CREATE TABLE IF NOT EXISTS bookmark_collection_posts (
  collection_id TEXT NOT NULL REFERENCES bookmark_collections(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(collection_id,post_id)
);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'database',
  mime_type TEXT NOT NULL,
  data TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS post_media (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY(post_id,media_id),
  UNIQUE(post_id,position)
);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id,position);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id,option_id);
CREATE INDEX IF NOT EXISTS idx_mentions_user ON mentions(mentioned_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_hashtags_tag ON content_hashtags(tag,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_contexts_context ON post_contexts(context_type,context_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookmark_collections_user ON bookmark_collections(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_media_post ON post_media(post_id,position);
`
  },
  {
    version: 7,
    name: 'campus_suite_communities',
    sql: `
CREATE TABLE IF NOT EXISTS project_applications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_applications_pending ON project_applications(project_id,user_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_project_applications_queue ON project_applications(project_id,status,created_at);
CREATE TABLE IF NOT EXISTS project_member_roles (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'Member',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id,user_id)
);
CREATE TABLE IF NOT EXISTS club_join_settings (
  club_id TEXT PRIMARY KEY REFERENCES clubs(id) ON DELETE CASCADE,
  join_mode TEXT NOT NULL DEFAULT 'open',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS club_membership_requests (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_club_requests_pending ON club_membership_requests(club_id,user_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_club_requests_queue ON club_membership_requests(club_id,status,created_at);
CREATE TABLE IF NOT EXISTS club_invites (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  invited_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_club_invites_pending ON club_invites(club_id,invited_user_id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS club_member_roles (
  club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'Member',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(club_id,user_id)
);
CREATE TABLE IF NOT EXISTS event_contexts (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  context_type TEXT NOT NULL,
  context_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_member_roles_role ON project_member_roles(project_id,role);
CREATE INDEX IF NOT EXISTS idx_club_member_roles_role ON club_member_roles(club_id,role);
CREATE INDEX IF NOT EXISTS idx_event_contexts_context ON event_contexts(context_type,context_id);
`
  },
  {
    version: 8,
    name: 'campus_suite_services',
    sql: `
CREATE TABLE IF NOT EXISTS marketplace_listings (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  item_condition TEXT NOT NULL DEFAULT '',
  price_inr INTEGER,
  location TEXT NOT NULL DEFAULT '',
  media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lost_found_entries (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  occurred_on TEXT NOT NULL,
  media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  anonymous INTEGER NOT NULL DEFAULT 0,
  accepted_answer_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS answer_votes (
  answer_id TEXT NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(answer_id,user_id)
);
CREATE TABLE IF NOT EXISTS report_dm_evidence (
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
  PRIMARY KEY(report_id,message_id)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_active ON marketplace_listings(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_owner ON marketplace_listings(owner_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lost_found_status ON lost_found_entries(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_questions_created ON questions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id,created_at);
CREATE INDEX IF NOT EXISTS idx_answer_votes_answer ON answer_votes(answer_id);
`
  },
  {
    version: 9,
    name: 'campus_suite_reminders_push',
    sql: `
CREATE TABLE IF NOT EXISTS event_reminders (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  minutes_before INTEGER NOT NULL,
  due_at TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(event_id,user_id)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_reminders_due ON event_reminders(sent_at,due_at,user_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id,updated_at DESC);
`
  }
];

async function applyMigrations(db) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);');
  const applied = new Set((await db.all('SELECT version FROM schema_migrations')).map(row => Number(row.version)));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    await db.transaction(async transaction => {
      await transaction.exec(migration.sql);
      await transaction.run(
        'INSERT INTO schema_migrations (version,name,applied_at) VALUES (?,?,?)',
        [migration.version, migration.name, new Date().toISOString()]
      );
    });
  }
}

module.exports = { migrations, applyMigrations };
