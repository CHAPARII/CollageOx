const { db, clean, pageLimit, requireUser, json, now } = require('./common');

async function blockedSet(userId) {
  const rows = await db.all(
    `SELECT blocker_id,blocked_id FROM user_blocks
     WHERE blocker_id=? OR blocked_id=?`,
    [userId, userId]
  );
  const set = new Set();
  for (const row of rows) set.add(row.blocker_id === userId ? row.blocked_id : row.blocker_id);
  return set;
}

function scoreText(query, values, createdAt = null) {
  const q = query.toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const raw of values.filter(Boolean)) {
    const value = String(raw).toLowerCase();
    if (value === q) score = Math.max(score, 100);
    else if (value.startsWith(q)) score = Math.max(score, 78);
    else if (value.split(/[^a-z0-9_]+/).includes(q)) score = Math.max(score, 62);
    else if (value.includes(q)) score = Math.max(score, 42);
    if (tokens.length > 1) {
      const hits = tokens.filter(token => value.includes(token)).length;
      score += Math.min(18, hits * 4);
    }
  }
  if (score && createdAt) {
    const ageDays = Math.max(0, (Date.now() - new Date(createdAt).getTime()) / 86400000);
    score += Math.max(0, 10 - Math.min(10, ageDays / 7));
  }
  return Math.round(score * 100) / 100;
}

function normalize(item) {
  return {
    type: item.type,
    id: item.id,
    title: item.title,
    subtitle: item.subtitle || '',
    snippet: item.snippet || '',
    score: item.score,
    createdAt: item.createdAt || null,
    route: item.route || ''
  };
}

async function peopleResults(user, q, blocked) {
  const rows = await db.all(
    `SELECT id,username,name,role,department,year,bio,profile_visibility,created_at
     FROM users
     WHERE (profile_visibility<>'private' OR id=?)
     ORDER BY created_at DESC LIMIT 200`,
    [user.id]
  );
  return rows.filter(row => !blocked.has(row.id)).map(row => {
    const score = scoreText(q, [row.username, row.name, row.department, row.year, row.bio], row.created_at);
    return normalize({
      type: 'people', id: row.id, title: row.name, subtitle: `@${row.username}${row.department ? ` · ${row.department}` : ''}`,
      snippet: row.bio, score, createdAt: row.created_at, route: `profile/${encodeURIComponent(row.username)}`
    });
  }).filter(item => item.score > 0);
}

async function postResults(user, q, blocked) {
  const rows = await db.all(
    `SELECT p.id,p.author_id,p.body,p.type,p.tags,p.created_at,u.username,u.name,u.profile_visibility
     FROM posts p JOIN users u ON u.id=p.author_id
     WHERE (u.profile_visibility<>'private' OR u.id=?)
     ORDER BY p.created_at DESC LIMIT 240`,
    [user.id]
  );
  return rows.filter(row => !blocked.has(row.author_id)).map(row => {
    const tags = json(row.tags, []);
    const score = scoreText(q, [row.body, row.type, row.username, row.name, ...tags], row.created_at);
    return normalize({
      type: 'posts', id: row.id, title: row.body.slice(0, 90) || 'Post', subtitle: `@${row.username} · ${row.type}`,
      snippet: tags.map(tag => `#${tag}`).join(' '), score, createdAt: row.created_at, route: `post:${row.id}`
    });
  }).filter(item => item.score > 0);
}

async function questionResults(user, q, blocked) {
  const rows = await db.all(
    `SELECT q.id,q.author_id,q.title,q.body,q.anonymous,q.created_at,u.username,u.name,u.profile_visibility
     FROM questions q JOIN users u ON u.id=q.author_id
     WHERE (u.profile_visibility<>'private' OR u.id=?)
     ORDER BY q.created_at DESC LIMIT 200`,
    [user.id]
  );
  return rows.filter(row => !blocked.has(row.author_id)).map(row => {
    const score = scoreText(q, [row.title, row.body, row.anonymous ? '' : row.username, row.anonymous ? '' : row.name], row.created_at);
    return normalize({
      type: 'qa',
      id: row.id,
      title: row.title,
      subtitle: row.anonymous ? 'Anonymous question' : `@${row.username} · Campus Q&A`,
      snippet: row.body,
      score,
      createdAt: row.created_at,
      route: `question:${row.id}`
    });
  }).filter(item => item.score > 0);
}

async function projectResults(q, blocked) {
  const rows = await db.all(
    `SELECT p.*,u.username FROM projects p JOIN users u ON u.id=p.owner_id
     WHERE p.status<>'archived' ORDER BY p.created_at DESC LIMIT 160`
  );
  return rows.filter(row => !blocked.has(row.owner_id)).map(row => {
    const skills = json(row.skills, []);
    const score = scoreText(q, [row.name, row.pitch, row.username, row.status, ...skills], row.created_at);
    return normalize({
      type: 'projects', id: row.id, title: row.name, subtitle: `${row.status} · by @${row.username}`,
      snippet: row.pitch, score, createdAt: row.created_at, route: 'projects'
    });
  }).filter(item => item.score > 0);
}

async function clubResults(q, blocked) {
  const rows = await db.all(
    `SELECT c.*,u.username,COALESCE(cs.status,'active') status
     FROM clubs c JOIN users u ON u.id=c.owner_id LEFT JOIN club_settings cs ON cs.club_id=c.id
     WHERE COALESCE(cs.status,'active')<>'archived'
     ORDER BY c.created_at DESC LIMIT 160`
  );
  return rows.filter(row => !blocked.has(row.owner_id)).map(row => {
    const score = scoreText(q, [row.name, row.description, row.category, row.username, row.status], row.created_at);
    return normalize({
      type: 'clubs', id: row.id, title: row.name, subtitle: `${row.category} · @${row.username}`,
      snippet: row.description, score, createdAt: row.created_at, route: 'clubs'
    });
  }).filter(item => item.score > 0);
}

async function eventResults(q, blocked) {
  const rows = await db.all(
    `SELECT e.*,u.username FROM events e JOIN users u ON u.id=e.creator_id
     WHERE e.starts_at>? ORDER BY e.starts_at ASC LIMIT 200`,
    [now()]
  );
  return rows.filter(row => !blocked.has(row.creator_id)).map(row => {
    const score = scoreText(q, [row.title, row.description, row.location, row.username], row.created_at);
    return normalize({
      type: 'events', id: row.id, title: row.title, subtitle: `${row.location || 'Location TBA'} · @${row.username}`,
      snippet: row.description, score, createdAt: row.created_at, route: 'events'
    });
  }).filter(item => item.score > 0);
}

async function marketplaceResults(q, blocked) {
  const rows = await db.all(
    `SELECT m.*,u.username FROM marketplace_listings m JOIN users u ON u.id=m.owner_id
     WHERE m.status='active' AND (m.expires_at IS NULL OR m.expires_at>?)
     ORDER BY m.created_at DESC LIMIT 200`,
    [now()]
  );
  return rows.filter(row => !blocked.has(row.owner_id)).map(row => {
    const score = scoreText(q, [row.title, row.description, row.category, row.item_condition, row.location, row.listing_type, row.username], row.created_at);
    return normalize({
      type: 'marketplace', id: row.id, title: row.title,
      subtitle: `${row.listing_type}${row.price_inr != null ? ` · ₹${row.price_inr}` : ''}`,
      snippet: `${row.description}${row.location ? ` · ${row.location}` : ''}`,
      score, createdAt: row.created_at, route: 'marketplace'
    });
  }).filter(item => item.score > 0);
}

async function lostFoundResults(q, blocked) {
  const rows = await db.all(
    `SELECT l.*,u.username FROM lost_found_entries l JOIN users u ON u.id=l.reporter_id
     WHERE l.status IN ('lost','found') ORDER BY l.created_at DESC LIMIT 200`
  );
  return rows.filter(row => !blocked.has(row.reporter_id)).map(row => {
    const score = scoreText(q, [row.name, row.description, row.location, row.status, row.username], row.created_at);
    return normalize({
      type: 'lostfound', id: row.id, title: row.name, subtitle: `${row.status} · ${row.location || 'Campus'}`,
      snippet: row.description, score, createdAt: row.created_at, route: 'lostfound'
    });
  }).filter(item => item.score > 0);
}

async function search(user, query, type = 'all', limit = 30) {
  const q = clean(query, 100).toLowerCase();
  if (!q) return [];
  const blocked = await blockedSet(user.id);
  const sources = {
    people: () => peopleResults(user, q, blocked),
    posts: () => postResults(user, q, blocked),
    qa: () => questionResults(user, q, blocked),
    clubs: () => clubResults(q, blocked),
    projects: () => projectResults(q, blocked),
    events: () => eventResults(q, blocked),
    marketplace: () => marketplaceResults(q, blocked),
    lostfound: () => lostFoundResults(q, blocked)
  };
  const normalizedType = type === 'lost & found' ? 'lostfound' : type;
  const groups = normalizedType === 'all'
    ? await Promise.all(Object.values(sources).map(load => load()))
    : [await (sources[normalizedType] || sources.people)()];
  return groups.flat().sort((a, b) => b.score - a.score || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, pageLimit(limit, 30, 80));
}

function registerRoutes(registerRoute) {
  registerRoute('GET', '/api/search', async ({ req, res, url }) => {
    const user = await requireUser(req);
    const type = clean(url.searchParams.get('type') || 'all', 30).toLowerCase().replace(/\s+/g, '');
    const items = await search(user, url.searchParams.get('q'), type, url.searchParams.get('limit'));
    res.json({ items });
    return true;
  });
}

module.exports = { registerRoutes, search, scoreText, blockedSet, questionResults };
