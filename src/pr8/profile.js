const {
  db,
  now,
  clean,
  json,
  readBody,
  requireUser,
  httpError,
  publicUser,
  bool
} = require('./common');
const { isBlocked } = require('./safety');

const NOTIFICATION_CATEGORIES = ['dm', 'mentions', 'projects', 'clubs', 'events', 'announcements', 'social'];

async function ensurePreferences(userId) {
  let row = await db.get('SELECT * FROM user_preferences WHERE user_id=?', [userId]);
  if (!row) {
    const timestamp = now();
    await db.run(
      `INSERT INTO user_preferences (user_id,available_for_projects,onboarding_complete,updated_at)
       VALUES (?,?,?,?) ON CONFLICT(user_id) DO NOTHING`,
      [userId, 0, 0, timestamp]
    );
    row = await db.get('SELECT * FROM user_preferences WHERE user_id=?', [userId]);
  }
  return row;
}

async function listSkills(userId) {
  return (await db.all(
    'SELECT normalized,label FROM user_skills WHERE user_id=? ORDER BY label ASC',
    [userId]
  )).map(row => row.label);
}

function normalizeSkill(value) {
  const label = clean(value, 50).replace(/\s+/g, ' ');
  const normalized = label.toLowerCase();
  return label && normalized ? { label, normalized } : null;
}

async function replaceSkills(userId, values, tx = db) {
  const seen = new Set();
  const skills = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const skill = normalizeSkill(raw);
    if (!skill || seen.has(skill.normalized)) continue;
    seen.add(skill.normalized);
    skills.push(skill);
    if (skills.length >= 20) break;
  }
  await tx.run('DELETE FROM user_skills WHERE user_id=?', [userId]);
  for (const skill of skills) {
    await tx.run(
      'INSERT INTO user_skills (user_id,normalized,label,created_at) VALUES (?,?,?,?)',
      [userId, skill.normalized, skill.label, now()]
    );
  }
  return skills.map(skill => skill.label).sort((a, b) => a.localeCompare(b));
}

async function notificationPreferences(userId) {
  const rows = await db.all('SELECT category,enabled FROM notification_preferences WHERE user_id=?', [userId]);
  const map = Object.fromEntries(rows.map(row => [row.category, !!row.enabled]));
  return Object.fromEntries(NOTIFICATION_CATEGORIES.map(category => [category, map[category] !== false]));
}

async function profileSummary(viewer, username) {
  const target = await db.get('SELECT * FROM users WHERE LOWER(username)=LOWER(?)', [clean(username, 24)]);
  if (!target || await isBlocked(viewer.id, target.id)) throw httpError(404, 'Profile not available.');
  const self = viewer.id === target.id;
  const privateView = !self && target.profile_visibility === 'private';
  const counts = await Promise.all([
    db.get('SELECT COUNT(*) n FROM posts WHERE author_id=?', [target.id]),
    db.get('SELECT COUNT(*) n FROM follows WHERE following_id=?', [target.id]),
    db.get('SELECT COUNT(*) n FROM follows WHERE follower_id=?', [target.id])
  ]);
  if (privateView) {
    return {
      user: publicUser(target),
      private: true,
      skills: [],
      availableForProjects: false,
      counts: { posts: 0, followers: Number(counts[1].n), following: Number(counts[2].n) },
      projects: [], clubs: [], events: [], pinnedPost: null
    };
  }
  const preferences = await ensurePreferences(target.id);
  const [skills, projects, clubs, events, pin] = await Promise.all([
    listSkills(target.id),
    db.all(
      `SELECT p.id,p.name,p.pitch,p.status,COALESCE(r.role,CASE WHEN p.owner_id=? THEN 'Lead' ELSE 'Member' END) member_role
       FROM project_members m JOIN projects p ON p.id=m.project_id
       LEFT JOIN project_member_roles r ON r.project_id=m.project_id AND r.user_id=m.user_id
       WHERE m.user_id=? AND p.status<>'archived' ORDER BY p.created_at DESC`,
      [target.id, target.id]
    ),
    db.all(
      `SELECT c.id,c.name,c.description,c.category,COALESCE(s.status,'active') status,
        COALESCE(r.role,CASE WHEN c.owner_id=? THEN 'Owner' ELSE 'Member' END) member_role
       FROM club_members m JOIN clubs c ON c.id=m.club_id
       LEFT JOIN club_settings s ON s.club_id=c.id
       LEFT JOIN club_member_roles r ON r.club_id=m.club_id AND r.user_id=m.user_id
       WHERE m.user_id=? AND COALESCE(s.status,'active')<>'archived' ORDER BY c.created_at DESC`,
      [target.id, target.id]
    ),
    db.all(
      `SELECT e.id,e.title,e.starts_at,e.location
       FROM event_attendees a JOIN events e ON e.id=a.event_id
       WHERE a.user_id=? AND e.starts_at>? ORDER BY e.starts_at ASC LIMIT 50`,
      [target.id, now()]
    ),
    db.get(
      `SELECT p.id,p.body,p.type,p.tags,p.created_at,p.edited_at
       FROM pinned_posts pin JOIN posts p ON p.id=pin.post_id
       WHERE pin.context_type='profile' AND pin.context_id=?`,
      [target.id]
    )
  ]);
  return {
    user: {
      ...publicUser(target),
      bio: target.bio,
      department: target.department,
      year: target.year,
      pronouns: target.pronouns,
      location: target.location,
      interests: json(target.interests, []),
      links: json(target.links, [])
    },
    private: false,
    skills,
    availableForProjects: !!preferences.available_for_projects,
    onboardingComplete: !!preferences.onboarding_complete,
    counts: { posts: Number(counts[0].n), followers: Number(counts[1].n), following: Number(counts[2].n) },
    projects: projects.map(row => ({ id: row.id, name: row.name, pitch: row.pitch, status: row.status, role: row.member_role })),
    clubs: clubs.map(row => ({ id: row.id, name: row.name, description: row.description, category: row.category, status: row.status, role: row.member_role })),
    events: events.map(row => ({ id: row.id, title: row.title, startsAt: row.starts_at, location: row.location })),
    pinnedPost: pin ? { id: pin.id, body: pin.body, type: pin.type, tags: json(pin.tags, []), createdAt: pin.created_at, editedAt: pin.edited_at } : null
  };
}

function registerRoutes(registerRoute) {
  registerRoute('GET', '/api/profile/skills', async ({ req, res }) => {
    const user = await requireUser(req);
    res.json({ skills: await listSkills(user.id) });
    return true;
  });

  registerRoute('PATCH', '/api/profile/skills', async ({ req, res }) => {
    const user = await requireUser(req);
    const input = await readBody(req);
    const skills = await db.transaction(tx => replaceSkills(user.id, input.skills, tx));
    res.json({ skills });
    return true;
  });

  registerRoute('GET', '/api/profile/preferences', async ({ req, res }) => {
    const user = await requireUser(req);
    const row = await ensurePreferences(user.id);
    res.json({
      availableForProjects: !!row.available_for_projects,
      onboardingComplete: !!row.onboarding_complete,
      notifications: await notificationPreferences(user.id)
    });
    return true;
  });

  registerRoute('PATCH', '/api/profile/preferences', async ({ req, res }) => {
    const user = await requireUser(req);
    const input = await readBody(req);
    const row = await ensurePreferences(user.id);
    const available = input.availableForProjects === undefined ? !!row.available_for_projects : bool(input.availableForProjects);
    await db.run(
      'UPDATE user_preferences SET available_for_projects=?,updated_at=? WHERE user_id=?',
      [available ? 1 : 0, now(), user.id]
    );
    res.json({ availableForProjects: available, onboardingComplete: !!row.onboarding_complete });
    return true;
  });

  registerRoute('GET', '/api/notification-preferences', async ({ req, res }) => {
    const user = await requireUser(req);
    res.json({ preferences: await notificationPreferences(user.id) });
    return true;
  });

  registerRoute('PATCH', '/api/notification-preferences', async ({ req, res }) => {
    const user = await requireUser(req);
    const input = await readBody(req);
    for (const category of NOTIFICATION_CATEGORIES) {
      if (input[category] === undefined) continue;
      await db.run(
        `INSERT INTO notification_preferences (user_id,category,enabled) VALUES (?,?,?)
         ON CONFLICT(user_id,category) DO UPDATE SET enabled=excluded.enabled`,
        [user.id, category, bool(input[category]) ? 1 : 0]
      );
    }
    res.json({ preferences: await notificationPreferences(user.id) });
    return true;
  });

  registerRoute('POST', '/api/onboarding/complete', async ({ req, res }) => {
    const user = await requireUser(req);
    const input = await readBody(req);
    const interests = (Array.isArray(input.interests) ? input.interests : []).map(value => clean(value, 50)).filter(Boolean).slice(0, 20);
    const timestamp = now();
    const skills = await db.transaction(async tx => {
      await tx.run(
        'UPDATE users SET department=?,year=?,interests=? WHERE id=?',
        [clean(input.department, 80), clean(input.year, 40), JSON.stringify(interests), user.id]
      );
      const savedSkills = await replaceSkills(user.id, input.skills, tx);
      await tx.run(
        `INSERT INTO user_preferences (user_id,available_for_projects,onboarding_complete,updated_at)
         VALUES (?,?,1,?) ON CONFLICT(user_id) DO UPDATE SET
         available_for_projects=excluded.available_for_projects,onboarding_complete=1,updated_at=excluded.updated_at`,
        [user.id, bool(input.availableForProjects) ? 1 : 0, timestamp]
      );
      return savedSkills;
    });
    res.json({ ok: true, skills });
    return true;
  });

  registerRoute('GET', /^\/api\/profiles\/([^/]+)\/summary$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    res.json(await profileSummary(user, decodeURIComponent(match[1])));
    return true;
  });
}

module.exports = {
  registerRoutes,
  ensurePreferences,
  listSkills,
  replaceSkills,
  notificationPreferences,
  profileSummary,
  NOTIFICATION_CATEGORIES
};
