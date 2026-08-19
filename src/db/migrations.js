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
