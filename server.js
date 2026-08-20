const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createDatabase, initializeDatabase } = require('./src/db');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const SESSION_MS = 1000 * 60 * 60 * 24 * 14;
const streams = new Set();
const rateBuckets = new Map();
const db = createDatabase();

const now = () => new Date().toISOString();
const id = prefix => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
const json = (value, fallback = []) => { try { return JSON.parse(value); } catch { return fallback; } };
const clean = (value, max = 500) => String(value || '').trim().slice(0, max);
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) =>
  `${salt}:${crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex')}`;

function verifyPassword(password, stored = '') {
  const [salt, digest] = stored.split(':');
  if (!salt || digest?.length !== 64) return false;
  const candidate = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256');
  return crypto.timingSafeEqual(candidate, Buffer.from(digest, 'hex'));
}

const safeUser = row => row ? ({
  id: row.id,
  username: row.username,
  email: row.email || '',
  name: row.name,
  role: row.role,
  bio: row.bio,
  department: row.department,
  year: row.year,
  pronouns: row.pronouns,
  location: row.location,
  avatar: row.avatar,
  accent: row.accent,
  interests: json(row.interests),
  links: json(row.links),
  profileVisibility: row.profile_visibility,
  createdAt: row.created_at
}) : null;

function publicUser(row, viewerId) {
  const out = safeUser(row);
  if (!out) return null;
  if (row.id !== viewerId) delete out.email;
  if (row.id !== viewerId && row.profile_visibility === 'private') {
    out.bio = '';
    out.department = '';
    out.year = '';
    out.pronouns = '';
    out.location = '';
    out.interests = [];
    out.links = [];
    out.private = true;
  }
  return out;
}

function managementUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    department: row.department,
    createdAt: row.created_at
  };
}

function campusDomains() {
  return String(process.env.CAMPUS_EMAIL_DOMAINS || '')
    .split(',')
    .map(value => value.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

function campusEmailAllowed(email) {
  const domains = campusDomains();
  if (!domains.length) return true;
  const domain = String(email).toLowerCase().split('@')[1] || '';
  return domains.some(allowed => domain === allowed || domain.endsWith(`.${allowed}`));
}

function audienceAllowed(user, audience) {
  if (['owner', 'management'].includes(user.role)) return true;
  if (audience === 'Everyone') return true;
  if (audience === 'Students') return user.role === 'student';
  if (audience === 'Faculty') return user.role === 'faculty';
  if (audience === 'Management') return false;
  if (audience.startsWith('Department:')) {
    return clean(user.department, 80).toLowerCase() === audience.slice(11).trim().toLowerCase();
  }
  return false;
}

function normalizeAudience(value) {
  const audience = clean(value, 100) || 'Everyone';
  if (['Everyone', 'Students', 'Faculty', 'Management'].includes(audience)) return audience;
  if (/^Department:\s*\S+/i.test(audience)) return `Department:${clean(audience.slice(audience.indexOf(':') + 1), 80)}`;
  return 'Everyone';
}

async function bootstrapOwner() {
  if (await db.get('SELECT id FROM users WHERE role=?', ['owner'])) return;
  const username = clean(process.env.OWNER_USERNAME, 24);
  const password = String(process.env.OWNER_INITIAL_PASSWORD || '');
  const email = clean(process.env.OWNER_EMAIL, 160).toLowerCase() || null;
  const name = clean(process.env.OWNER_NAME, 60) || username;
  if (!/^[a-zA-Z0-9_.]{3,24}$/.test(username) || password.length < 10) {
    throw new Error('No owner account exists. Set OWNER_USERNAME and OWNER_INITIAL_PASSWORD (at least 10 characters), then restart.');
  }
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new Error('OWNER_EMAIL must be a valid email address.');
  await db.run(
    `INSERT INTO users (id,username,email,password_hash,name,role,bio,accent,created_at)
     VALUES (?,?,?,?,?,'owner','','#155eef',?)`,
    [id('owner'), username, email, hashPassword(password), name, now()]
  );
  console.log(`Created owner account @${username}. Change its initial password after signing in.`);
}

const ready = initializeDatabase(db).then(bootstrapOwner);

function send(res, status, payload) {
  const out = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(out)
  });
  res.end(out);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 900000) reject(Object.assign(new Error('Request too large'), { status: 413 }));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function cookieMap(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(value => {
    const parts = value.trim().split('=');
    return [decodeURIComponent(parts.shift()), decodeURIComponent(parts.join('='))];
  }));
}

async function currentUser(req) {
  const token = cookieMap(req).collegeox_session;
  if (!token) return null;
  return await db.get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.expires_at>?`,
    [tokenHash(token), Date.now()]
  ) || null;
}

async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.run('DELETE FROM sessions WHERE expires_at<?', [Date.now()]);
  await db.run('INSERT INTO sessions VALUES (?,?,?)', [tokenHash(token), userId, Date.now() + SESSION_MS]);
  res.setHeader(
    'Set-Cookie',
    `collegeox_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
  );
}

async function endSession(req, res) {
  const token = cookieMap(req).collegeox_session;
  if (token) await db.run('DELETE FROM sessions WHERE token_hash=?', [tokenHash(token)]);
  res.setHeader('Set-Cookie', 'collegeox_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; }
  catch { return false; }
}

function rate(req, bucket, max, windowMs = 60000) {
  const key = `${bucket}:${req.socket.remoteAddress || 'local'}`;
  const time = Date.now();
  let item = rateBuckets.get(key);
  if (!item || item.reset < time) item = { count: 0, reset: time + windowMs };
  item.count++;
  rateBuckets.set(key, item);
  return item.count <= max;
}

const requireRole = (user, roles) => user && roles.includes(user.role);

function broadcast(kind, payload = {}) {
  const message = `event: ${kind}\ndata: ${JSON.stringify({ kind, ...payload })}\n\n`;
  for (const stream of streams) {
    try { stream.write(message); }
    catch { streams.delete(stream); }
  }
}

function pageLimit(value, fallback = 20, max = 50) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(1, Math.floor(parsed))) : fallback;
}

async function postRows(userId, options = {}) {
  const {
    scope = 'all',
    authorId = null,
    postId = null,
    saved = false,
    cursor = null,
    limit = 20
  } = options;
  const where = [];
  const params = [userId, userId, userId];

  if (scope === 'following') {
    where.push('EXISTS(SELECT 1 FROM follows ff WHERE ff.follower_id=? AND ff.following_id=p.author_id)');
    params.push(userId);
  }
  if (authorId) {
    where.push('p.author_id=?');
    params.push(authorId);
  }
  if (postId) {
    where.push('p.id=?');
    params.push(postId);
  }
  if (saved) {
    where.push('EXISTS(SELECT 1 FROM saved_posts sp2 WHERE sp2.user_id=? AND sp2.post_id=p.id)');
    params.push(userId);
  }
  if (cursor) {
    where.push('p.created_at<?');
    params.push(cursor);
  }

  const rows = await db.all(
    `SELECT p.*,u.username,u.name,u.role,u.avatar,u.accent,u.department,
      (SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id AND r.kind='like') reaction_count,
      EXISTS(SELECT 1 FROM reactions r WHERE r.post_id=p.id AND r.user_id=? AND r.kind='like') reacted,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) comment_count,
      EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=? AND f.following_id=p.author_id) following_author,
      EXISTS(SELECT 1 FROM saved_posts sp WHERE sp.user_id=? AND sp.post_id=p.id) saved
     FROM posts p JOIN users u ON u.id=p.author_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY p.created_at DESC LIMIT ${pageLimit(limit, 20, 50)}`,
    params
  );

  if (!rows.length) return [];
  const postIds = rows.map(row => row.id);
  const placeholders = postIds.map(() => '?').join(',');
  const comments = await db.all(
    `SELECT c.*,u.username,u.name,u.role,u.avatar,u.accent
     FROM comments c JOIN users u ON u.id=c.author_id
     WHERE c.post_id IN (${placeholders})
     ORDER BY c.created_at ASC`,
    postIds
  );
  const commentsByPost = new Map(postIds.map(postId => [postId, []]));
  for (const comment of comments) commentsByPost.get(comment.post_id)?.push(comment);

  return rows.map(row => ({
    id: row.id,
    body: row.body,
    type: row.type,
    tags: json(row.tags),
    createdAt: row.created_at,
    editedAt: row.edited_at,
    reactionCount: Number(row.reaction_count),
    reacted: !!row.reacted,
    commentCount: Number(row.comment_count),
    followingAuthor: !!row.following_author,
    saved: !!row.saved,
    author: {
      id: row.author_id,
      username: row.username,
      name: row.name,
      role: row.role,
      avatar: row.avatar,
      accent: row.accent,
      department: row.department
    },
    comments: (commentsByPost.get(row.id) || []).map(comment => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.created_at,
      author: {
        id: comment.author_id,
        username: comment.username,
        name: comment.name,
        role: comment.role,
        avatar: comment.avatar,
        accent: comment.accent
      }
    }))
  }));
}

async function profilePayload(target, viewerId) {
  const counts = await db.get(
    `SELECT
      (SELECT COUNT(*) FROM follows WHERE following_id=?) followers,
      (SELECT COUNT(*) FROM follows WHERE follower_id=?) following,
      (SELECT COUNT(*) FROM posts WHERE author_id=?) posts`,
    [target.id, target.id, target.id]
  );
  const followed = viewerId
    ? !!(await db.get('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?', [viewerId, target.id]))
    : false;
  return {
    user: publicUser(target, viewerId),
    counts: {
      followers: Number(counts.followers),
      following: Number(counts.following),
      posts: Number(counts.posts)
    },
    followed
  };
}

async function listProjects(userId) {
  const rows = await db.all(
    `SELECT p.*,u.username,u.name,
      (SELECT COUNT(*) FROM project_members m WHERE m.project_id=p.id) members,
      EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=?) joined
     FROM projects p JOIN users u ON u.id=p.owner_id
     WHERE p.status<>'archived'
     ORDER BY p.created_at DESC`,
    [userId]
  );
  return rows.map(row => ({
    ...row,
    members: Number(row.members),
    joined: !!row.joined,
    isOwner: row.owner_id === userId,
    skills: json(row.skills)
  }));
}

async function listClubs(userId) {
  const rows = await db.all(
    `SELECT c.*,u.username,COALESCE(cs.status,'active') status,
      (SELECT COUNT(*) FROM club_members m WHERE m.club_id=c.id) members,
      EXISTS(SELECT 1 FROM club_members m WHERE m.club_id=c.id AND m.user_id=?) joined
     FROM clubs c JOIN users u ON u.id=c.owner_id
     LEFT JOIN club_settings cs ON cs.club_id=c.id
     WHERE COALESCE(cs.status,'active')<>'archived'
     ORDER BY c.created_at DESC`,
    [userId]
  );
  return rows.map(row => ({
    ...row,
    members: Number(row.members),
    joined: !!row.joined,
    isOwner: row.owner_id === userId
  }));
}

async function listEvents(userId) {
  const rows = await db.all(
    `SELECT e.*,u.username,
      (SELECT COUNT(*) FROM event_attendees a WHERE a.event_id=e.id) attendees,
      EXISTS(SELECT 1 FROM event_attendees a WHERE a.event_id=e.id AND a.user_id=?) going
     FROM events e JOIN users u ON u.id=e.creator_id
     WHERE e.starts_at>=?
     ORDER BY e.starts_at`,
    [userId, now()]
  );
  return rows.map(row => ({
    ...row,
    attendees: Number(row.attendees),
    going: !!row.going,
    isCreator: row.creator_id === userId
  }));
}

async function listAnnouncements(user) {
  const rows = await db.all(
    `SELECT a.*,u.username,u.name FROM announcements a
     JOIN users u ON u.id=a.author_id
     ORDER BY a.created_at DESC LIMIT 100`
  );
  return rows.filter(row => audienceAllowed(user, row.audience));
}

async function clubMessages(clubId) {
  const rows = await db.all(
    `SELECT * FROM (
       SELECT m.id,m.body,m.created_at,u.id author_id,u.username,u.name,u.role,u.avatar,u.accent
       FROM club_messages m JOIN users u ON u.id=m.author_id
       WHERE m.club_id=? ORDER BY m.created_at DESC LIMIT 200
     ) recent_messages ORDER BY created_at ASC`,
    [clubId]
  );
  return rows.map(row => ({
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    author: {
      id: row.author_id,
      username: row.username,
      name: row.name,
      role: row.role,
      avatar: row.avatar,
      accent: row.accent
    }
  }));
}

async function issueMessages(issueId, user) {
  const canSeePrivate = requireRole(user, ['owner', 'management']);
  const rows = await db.all(
    `SELECT m.*,u.username,u.name,u.role FROM issue_messages m
     JOIN users u ON u.id=m.author_id
     WHERE m.issue_id=? ${canSeePrivate ? '' : "AND m.visibility='public'"}
     ORDER BY m.created_at ASC`,
    [issueId]
  );
  return rows.map(row => ({
    id: row.id,
    body: row.body,
    visibility: row.visibility,
    createdAt: row.created_at,
    author: { id: row.author_id, username: row.username, name: row.name, role: row.role }
  }));
}

async function issueRows(user) {
  let rows;
  if (requireRole(user, ['owner', 'management'])) {
    rows = await db.all(
      `SELECT i.*,u.username,u.name FROM issues i JOIN users u ON u.id=i.reporter_id
       ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,i.created_at DESC`
    );
  } else {
    rows = await db.all(
      `SELECT id,reporter_id,subject,description,category,status,created_at,updated_at
       FROM issues WHERE reporter_id=? ORDER BY created_at DESC`,
      [user.id]
    );
  }
  return Promise.all(rows.map(async row => ({ ...row, messages: await issueMessages(row.id, user) })));
}

async function aiAssist(input, user) {
  if (!process.env.OPENAI_API_KEY) {
    throw Object.assign(new Error('AI is not configured yet. Add OPENAI_API_KEY on the server to enable it.'), { status: 503 });
  }
  const mode = ['rewrite', 'summarize', 'brainstorm', 'moderate'].includes(input.mode) ? input.mode : 'rewrite';
  const instructions = {
    rewrite: 'Improve clarity and tone while preserving meaning. Return only the revised text.',
    summarize: 'Summarize into concise action items. Return only the summary.',
    brainstorm: 'Suggest five practical campus-focused ideas. Be concise.',
    moderate: 'Assess this campus post for harassment, hate, sexual content, self-harm, threats, spam, or personal data. Return compact JSON with allowed boolean, categories array, and reason.'
  }[mode];
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5-mini',
      instructions: `${instructions} You are assisting ${user.name} inside a college community platform.`,
      input: clean(input.text, 5000),
      max_output_tokens: 500
    })
  });
  if (!response.ok) throw Object.assign(new Error('The AI provider could not complete that request.'), { status: 502 });
  const data = await response.json();
  return data.output_text || data.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text || '';
}

async function moderatePost(text, user) {
  if (!process.env.OPENAI_API_KEY) return { checked: false, unavailable: false };
  try {
    const verdict = await aiAssist({ mode: 'moderate', text }, user);
    const start = verdict.indexOf('{');
    const end = verdict.lastIndexOf('}');
    if (start < 0 || end < start) return { checked: false, unavailable: true };
    const parsed = JSON.parse(verdict.slice(start, end + 1));
    if (parsed.allowed === false) {
      return { checked: true, blocked: true, reason: clean(parsed.reason, 240) || 'unsafe content detected.' };
    }
    return { checked: true, blocked: false };
  } catch (error) {
    console.error(`AI moderation unavailable: ${error.message}`);
    return { checked: false, unavailable: true };
  }
}

async function api(req, res, pathname, url) {
  const method = req.method;
  const user = await currentUser(req);
  if (method !== 'GET' && !originAllowed(req)) return send(res, 403, { error: 'Origin rejected' });

  if (pathname === '/api/health') {
    return send(res, 200, {
      ok: true,
      database: db.kind,
      realtime: true,
      ai: !!process.env.OPENAI_API_KEY,
      campusEmailRestricted: campusDomains().length > 0
    });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    if (!rate(req, 'login', 10)) return send(res, 429, { error: 'Too many sign-in attempts. Try again in one minute.' });
    const input = await readBody(req);
    const login = clean(input.login, 120);
    const found = await db.get(
      'SELECT * FROM users WHERE LOWER(username)=LOWER(?) OR LOWER(email)=LOWER(?)',
      [login, login]
    );
    if (!found || !verifyPassword(String(input.password || ''), found.password_hash)) {
      return send(res, 401, { error: 'Those sign-in details do not match an account.' });
    }
    await startSession(res, found.id);
    return send(res, 200, { user: safeUser(found) });
  }

  if (pathname === '/api/auth/register' && method === 'POST') {
    if (!rate(req, 'register', 20, 300000)) return send(res, 429, { error: 'Too many account attempts. Please wait.' });
    const input = await readBody(req);
    const username = clean(input.username, 24);
    const email = clean(input.email, 160).toLowerCase();
    const password = String(input.password || '');
    const name = clean(input.name, 60);
    if (!/^[a-zA-Z0-9_.]{3,24}$/.test(username)) {
      return send(res, 400, { error: 'Username must be 3–24 letters, numbers, dots, or underscores.' });
    }
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10 || !name) {
      return send(res, 400, { error: 'Add your name, campus email, and a password of at least 10 characters.' });
    }
    if (!campusEmailAllowed(email)) {
      return send(res, 400, { error: 'Use an email address from an allowed campus domain.' });
    }
    if (await db.get(
      'SELECT 1 FROM users WHERE LOWER(username)=LOWER(?) OR LOWER(email)=LOWER(?)',
      [username, email]
    )) {
      return send(res, 409, { error: 'That username or email is already in use.' });
    }
    const next = { id: id('usr'), username, email, password: hashPassword(password), name };
    await db.run(
      `INSERT INTO users (id,username,email,password_hash,name,role,created_at)
       VALUES (?,?,?,?,?,'student',?)`,
      [next.id, next.username, next.email, next.password, next.name, now()]
    );
    await startSession(res, next.id);
    return send(res, 201, { user: safeUser(await db.get('SELECT * FROM users WHERE id=?', [next.id])) });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    await endSession(req, res);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/me') {
    return send(res, 200, {
      user: safeUser(user),
      aiEnabled: !!process.env.OPENAI_API_KEY,
      campusEmailRestricted: campusDomains().length > 0
    });
  }

  if (!user) return send(res, 401, { error: 'Sign in required.' });

  if (pathname === '/api/auth/password' && method === 'POST') {
    const input = await readBody(req);
    const currentPassword = String(input.currentPassword || '');
    const newPassword = String(input.newPassword || '');
    if (!verifyPassword(currentPassword, user.password_hash)) return send(res, 401, { error: 'Current password is incorrect.' });
    if (newPassword.length < 10) return send(res, 400, { error: 'New password must be at least 10 characters.' });
    if (currentPassword === newPassword) return send(res, 400, { error: 'Choose a different password.' });
    await db.transaction(async tx => {
      await tx.run('UPDATE users SET password_hash=? WHERE id=?', [hashPassword(newPassword), user.id]);
      await tx.run('DELETE FROM sessions WHERE user_id=?', [user.id]);
    });
    await startSession(res, user.id);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/stream' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('event: ready\ndata: {"ok":true}\n\n');
    streams.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); }
      catch { clearInterval(ping); streams.delete(res); }
    }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      streams.delete(res);
    });
    return;
  }

  if (pathname === '/api/bootstrap' && method === 'GET') {
    const summaryOnly = url.searchParams.get('summary') === '1';
    const [peopleCount, postCount, clubCount, announcements] = await Promise.all([
      db.get('SELECT COUNT(*) n FROM users'),
      db.get('SELECT COUNT(*) n FROM posts'),
      db.get('SELECT COUNT(*) n FROM clubs'),
      listAnnouncements(user)
    ]);
    const base = {
      user: safeUser(user),
      aiEnabled: !!process.env.OPENAI_API_KEY,
      announcements: summaryOnly ? announcements.slice(0, 4) : announcements,
      counts: {
        people: Number(peopleCount.n),
        posts: Number(postCount.n),
        clubs: Number(clubCount.n)
      }
    };
    if (summaryOnly) return send(res, 200, base);
    const [posts, projects, clubs, events] = await Promise.all([
      postRows(user.id, { limit: 20 }),
      listProjects(user.id),
      listClubs(user.id),
      listEvents(user.id)
    ]);
    return send(res, 200, { ...base, posts, projects, clubs, events });
  }

  if (pathname === '/api/profile' && method === 'PATCH') {
    const input = await readBody(req);
    const username = clean(input.username, 24);
    if (!/^[a-zA-Z0-9_.]{3,24}$/.test(username)) return send(res, 400, { error: 'Choose a valid username.' });
    if (await db.get('SELECT id FROM users WHERE LOWER(username)=LOWER(?) AND id<>?', [username, user.id])) {
      return send(res, 409, { error: 'That username is taken.' });
    }
    const avatar = String(input.avatar || '');
    if (avatar && (!avatar.startsWith('data:image/') || avatar.length > 650000)) {
      return send(res, 400, { error: 'Profile image must be under 450 KB.' });
    }
    const interests = Array.isArray(input.interests)
      ? input.interests.slice(0, 12).map(value => clean(value, 28)).filter(Boolean)
      : [];
    const links = Array.isArray(input.links)
      ? input.links.slice(0, 5)
        .map(value => ({ label: clean(value.label, 30) || 'Link', url: clean(value.url, 300) }))
        .filter(value => /^https?:\/\//.test(value.url))
      : [];
    await db.run(
      `UPDATE users SET username=?,name=?,bio=?,department=?,year=?,pronouns=?,location=?,avatar=?,accent=?,interests=?,links=?,profile_visibility=?
       WHERE id=?`,
      [
        username,
        clean(input.name, 60) || user.name,
        clean(input.bio, 300),
        clean(input.department, 80),
        clean(input.year, 30),
        clean(input.pronouns, 30),
        clean(input.location, 80),
        avatar,
        /^#[0-9a-fA-F]{6}$/.test(input.accent || '') ? input.accent : '#155eef',
        JSON.stringify(interests),
        JSON.stringify(links),
        input.profileVisibility === 'private' ? 'private' : 'campus',
        user.id
      ]
    );
    const updated = await db.get('SELECT * FROM users WHERE id=?', [user.id]);
    broadcast('profile', { userId: user.id });
    return send(res, 200, { user: safeUser(updated) });
  }

  let match = pathname.match(/^\/api\/profiles\/([^/]+)$/);
  if (match && method === 'GET') {
    const target = await db.get('SELECT * FROM users WHERE LOWER(username)=LOWER(?)', [decodeURIComponent(match[1])]);
    if (!target) return send(res, 404, { error: 'Profile not found.' });
    const privateView = target.id !== user.id && target.profile_visibility === 'private';
    return send(res, 200, {
      ...await profilePayload(target, user.id),
      posts: privateView ? [] : await postRows(user.id, { authorId: target.id, limit: 30 }),
      private: privateView
    });
  }

  if (pathname === '/api/users/search' && method === 'GET') {
    const q = clean(url.searchParams.get('q'), 60);
    if (!q) return send(res, 200, { users: [] });
    const escaped = q.replace(/[\\%_]/g, value => `\\${value}`);
    const like = `%${escaped}%`;
    const rows = await db.all(
      `SELECT * FROM users
       WHERE profile_visibility<>'private'
       AND (LOWER(username) LIKE LOWER(?) ESCAPE '\\' OR LOWER(name) LIKE LOWER(?) ESCAPE '\\' OR LOWER(department) LIKE LOWER(?) ESCAPE '\\')
       ORDER BY CASE WHEN LOWER(username)=LOWER(?) THEN 0 ELSE 1 END,name LIMIT 30`,
      [like, like, like, q]
    );
    return send(res, 200, { users: await Promise.all(rows.map(row => profilePayload(row, user.id))) });
  }

  match = pathname.match(/^\/api\/users\/([^/]+)\/follow$/);
  if (match && method === 'POST') {
    const target = await db.get('SELECT id FROM users WHERE id=?', [match[1]]);
    if (!target) return send(res, 404, { error: 'User not found.' });
    if (match[1] === user.id) return send(res, 400, { error: 'You cannot follow yourself.' });
    const exists = await db.get('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?', [user.id, match[1]]);
    if (exists) await db.run('DELETE FROM follows WHERE follower_id=? AND following_id=?', [user.id, match[1]]);
    else await db.run('INSERT INTO follows VALUES (?,?,?)', [user.id, match[1], now()]);
    broadcast('follow', { userId: match[1] });
    return send(res, 200, { following: !exists });
  }

  if (pathname === '/api/posts' && method === 'GET') {
    const limit = pageLimit(url.searchParams.get('limit'), 20, 50);
    const cursor = clean(url.searchParams.get('cursor'), 40) || null;
    const scope = url.searchParams.get('scope') === 'following' ? 'following' : 'all';
    const saved = url.searchParams.get('saved') === '1';
    const posts = await postRows(user.id, { limit: limit + 1, cursor, scope, saved });
    const hasMore = posts.length > limit;
    const page = hasMore ? posts.slice(0, limit) : posts;
    return send(res, 200, {
      posts: page,
      nextCursor: hasMore ? page[page.length - 1]?.createdAt || null : null
    });
  }

  if (pathname === '/api/posts' && method === 'POST') {
    const input = await readBody(req);
    const text = clean(input.body, 1800);
    if (!text) return send(res, 400, { error: 'Write something before publishing.' });
    const moderation = await moderatePost(text, user);
    if (moderation.blocked) {
      return send(res, 422, { error: `This post was held by AI moderation: ${moderation.reason}` });
    }
    const tags = (Array.isArray(input.tags) ? input.tags : [])
      .slice(0, 6)
      .map(value => clean(String(value).replace(/[^\w-]/g, ''), 24))
      .filter(Boolean);
    const postId = id('post');
    await db.run(
      'INSERT INTO posts (id,author_id,body,type,tags,created_at) VALUES (?,?,?,?,?,?)',
      [postId, user.id, text, ['post', 'question', 'collab', 'update'].includes(input.type) ? input.type : 'post', JSON.stringify(tags), now()]
    );
    broadcast('post', { postId });
    return send(res, 201, {
      post: (await postRows(user.id, { postId, limit: 1 }))[0],
      moderated: moderation.checked,
      moderationUnavailable: moderation.unavailable
    });
  }

  match = pathname.match(/^\/api\/posts\/([^/]+)$/);
  if (match && method === 'GET') {
    const post = (await postRows(user.id, { postId: match[1], limit: 1 }))[0];
    if (!post) return send(res, 404, { error: 'Post not found.' });
    return send(res, 200, { post });
  }

  if (match && method === 'PATCH') {
    const post = await db.get('SELECT * FROM posts WHERE id=?', [match[1]]);
    if (!post) return send(res, 404, { error: 'Post not found.' });
    if (post.author_id !== user.id) return send(res, 403, { error: 'You can only edit your own posts.' });
    const input = await readBody(req);
    const body = clean(input.body, 1800);
    if (!body) return send(res, 400, { error: 'Post cannot be empty.' });
    const tags = (Array.isArray(input.tags) ? input.tags : json(post.tags))
      .slice(0, 6).map(value => clean(String(value).replace(/[^\w-]/g, ''), 24)).filter(Boolean);
    const type = ['post', 'question', 'collab', 'update'].includes(input.type) ? input.type : post.type;
    await db.run('UPDATE posts SET body=?,type=?,tags=?,edited_at=? WHERE id=?', [body, type, JSON.stringify(tags), now(), post.id]);
    broadcast('post', { postId: post.id });
    return send(res, 200, { post: (await postRows(user.id, { postId: post.id, limit: 1 }))[0] });
  }

  if (match && method === 'DELETE') {
    const post = await db.get('SELECT * FROM posts WHERE id=?', [match[1]]);
    if (!post) return send(res, 404, { error: 'Post not found.' });
    if (post.author_id !== user.id && !requireRole(user, ['owner', 'management'])) {
      return send(res, 403, { error: 'You cannot delete this post.' });
    }
    await db.run('DELETE FROM posts WHERE id=?', [match[1]]);
    broadcast('deletePost', { postId: match[1] });
    return send(res, 200, { ok: true });
  }

  match = pathname.match(/^\/api\/posts\/([^/]+)\/react$/);
  if (match && method === 'POST') {
    const post = await db.get('SELECT id FROM posts WHERE id=?', [match[1]]);
    if (!post) return send(res, 404, { error: 'Post not found.' });
    const existing = await db.get('SELECT 1 FROM reactions WHERE post_id=? AND user_id=?', [match[1], user.id]);
    if (existing) {
      await db.run('DELETE FROM reactions WHERE post_id=? AND user_id=?', [match[1], user.id]);
    } else {
      await db.run('INSERT INTO reactions VALUES (?,?,?)', [match[1], user.id, 'like']);
    }
    broadcast('reaction', { postId: match[1] });
    return send(res, 200, { post: (await postRows(user.id, { postId: match[1], limit: 1 }))[0] });
  }

  match = pathname.match(/^\/api\/posts\/([^/]+)\/save$/);
  if (match && method === 'POST') {
    const post = await db.get('SELECT id FROM posts WHERE id=?', [match[1]]);
    if (!post) return send(res, 404, { error: 'Post not found.' });
    const existing = await db.get('SELECT 1 FROM saved_posts WHERE user_id=? AND post_id=?', [user.id, match[1]]);
    if (existing) await db.run('DELETE FROM saved_posts WHERE user_id=? AND post_id=?', [user.id, match[1]]);
    else await db.run('INSERT INTO saved_posts VALUES (?,?,?)', [user.id, match[1], now()]);
    return send(res, 200, { saved: !existing });
  }

  match = pathname.match(/^\/api\/posts\/([^/]+)\/comments$/);
  if (match && method === 'POST') {
    const post = await db.get('SELECT id FROM posts WHERE id=?', [match[1]]);
    if (!post) return send(res, 404, { error: 'Post not found.' });
    const input = await readBody(req);
    const text = clean(input.body, 600);
    if (!text) return send(res, 400, { error: 'Comment cannot be empty.' });
    await db.run('INSERT INTO comments VALUES (?,?,?,?,?)', [id('com'), match[1], user.id, text, now()]);
    broadcast('comment', { postId: match[1] });
    return send(res, 201, { post: (await postRows(user.id, { postId: match[1], limit: 1 }))[0] });
  }

  if (pathname === '/api/projects' && method === 'GET') {
    return send(res, 200, { projects: await listProjects(user.id) });
  }

  if (pathname === '/api/projects' && method === 'POST') {
    const input = await readBody(req);
    const name = clean(input.name, 80);
    const pitch = clean(input.pitch, 600);
    if (!name || !pitch) return send(res, 400, { error: 'Project name and pitch are required.' });
    const projectId = id('prj');
    await db.transaction(async tx => {
      await tx.run(
        'INSERT INTO projects VALUES (?,?,?,?,?,?,?,?)',
        [
          projectId,
          user.id,
          name,
          pitch,
          JSON.stringify((input.skills || []).slice(0, 8).map(value => clean(value, 24))),
          Math.min(30, Math.max(2, Number(input.capacity) || 4)),
          'recruiting',
          now()
        ]
      );
      await tx.run('INSERT INTO project_members VALUES (?,?,?)', [projectId, user.id, now()]);
    });
    broadcast('project', { id: projectId });
    return send(res, 201, { project: (await listProjects(user.id)).find(item => item.id === projectId) });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/join$/);
  if (match && method === 'POST') {
    const project = await db.get(
      'SELECT p.*,(SELECT COUNT(*) FROM project_members WHERE project_id=?) n FROM projects p WHERE p.id=?',
      [match[1], match[1]]
    );
    if (!project) return send(res, 404, { error: 'Project not found.' });
    const exists = await db.get('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', [match[1], user.id]);
    if (exists) {
      if (project.owner_id === user.id) return send(res, 409, { error: 'The project owner cannot leave their own project.' });
      await db.run('DELETE FROM project_members WHERE project_id=? AND user_id=?', [match[1], user.id]);
    } else {
      if (!['recruiting', 'active'].includes(project.status)) return send(res, 409, { error: 'This project is not accepting members.' });
      if (Number(project.n) >= Number(project.capacity)) return send(res, 409, { error: 'This team is full.' });
      await db.run('INSERT INTO project_members VALUES (?,?,?)', [match[1], user.id, now()]);
    }
    broadcast('project', { id: match[1] });
    return send(res, 200, { joined: !exists });
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (match && method === 'PATCH') {
    const project = await db.get('SELECT * FROM projects WHERE id=?', [match[1]]);
    if (!project) return send(res, 404, { error: 'Project not found.' });
    if (project.owner_id !== user.id && !requireRole(user, ['owner', 'management'])) {
      return send(res, 403, { error: 'Only the project owner or management can change its status.' });
    }
    const input = await readBody(req);
    const status = ['recruiting', 'active', 'completed', 'archived'].includes(input.status) ? input.status : project.status;
    await db.run('UPDATE projects SET status=? WHERE id=?', [status, project.id]);
    broadcast('project', { id: project.id });
    return send(res, 200, { ok: true, status });
  }

  if (pathname === '/api/clubs' && method === 'GET') {
    return send(res, 200, { clubs: await listClubs(user.id) });
  }

  if (pathname === '/api/clubs' && method === 'POST') {
    const input = await readBody(req);
    if (!clean(input.name) || !clean(input.description)) return send(res, 400, { error: 'Club name and description are required.' });
    const clubId = id('club');
    try {
      await db.transaction(async tx => {
        await tx.run(
          'INSERT INTO clubs VALUES (?,?,?,?,?,?,?)',
          [
            clubId,
            user.id,
            clean(input.name, 80),
            clean(input.description, 500),
            clean(input.category, 40) || 'Community',
            /^#[0-9a-fA-F]{6}$/.test(input.accent || '') ? input.accent : '#ff6b4a',
            now()
          ]
        );
        await tx.run('INSERT INTO club_members VALUES (?,?,?)', [clubId, user.id, now()]);
        await tx.run('INSERT INTO club_settings VALUES (?,?,?)', [clubId, 'active', now()]);
      });
    } catch {
      return send(res, 409, { error: 'A club with that name already exists.' });
    }
    broadcast('club', { id: clubId });
    return send(res, 201, { club: (await listClubs(user.id)).find(item => item.id === clubId) });
  }

  match = pathname.match(/^\/api\/clubs\/([^/]+)\/join$/);
  if (match && method === 'POST') {
    const club = await db.get(
      `SELECT c.*,COALESCE(cs.status,'active') status FROM clubs c
       LEFT JOIN club_settings cs ON cs.club_id=c.id WHERE c.id=?`,
      [match[1]]
    );
    if (!club) return send(res, 404, { error: 'Club not found.' });
    const exists = await db.get('SELECT 1 FROM club_members WHERE club_id=? AND user_id=?', [match[1], user.id]);
    if (exists) {
      if (club.owner_id === user.id) return send(res, 409, { error: 'The club owner cannot leave their own club.' });
      await db.run('DELETE FROM club_members WHERE club_id=? AND user_id=?', [match[1], user.id]);
    } else {
      if (club.status !== 'active') return send(res, 409, { error: 'This club is not accepting new members.' });
      await db.run('INSERT INTO club_members VALUES (?,?,?)', [match[1], user.id, now()]);
    }
    broadcast('club', { id: match[1] });
    return send(res, 200, { joined: !exists });
  }

  match = pathname.match(/^\/api\/clubs\/([^/]+)$/);
  if (match && method === 'PATCH') {
    const club = await db.get('SELECT * FROM clubs WHERE id=?', [match[1]]);
    if (!club) return send(res, 404, { error: 'Club not found.' });
    if (club.owner_id !== user.id && !requireRole(user, ['owner', 'management'])) {
      return send(res, 403, { error: 'Only the club owner or management can change its status.' });
    }
    const input = await readBody(req);
    const status = ['active', 'closed', 'archived'].includes(input.status) ? input.status : 'active';
    const existing = await db.get('SELECT 1 FROM club_settings WHERE club_id=?', [club.id]);
    if (existing) await db.run('UPDATE club_settings SET status=?,updated_at=? WHERE club_id=?', [status, now(), club.id]);
    else await db.run('INSERT INTO club_settings VALUES (?,?,?)', [club.id, status, now()]);
    broadcast('club', { id: club.id });
    return send(res, 200, { ok: true, status });
  }

  match = pathname.match(/^\/api\/clubs\/([^/]+)\/messages$/);
  if (match) {
    const club = await db.get(
      `SELECT c.id,c.name,c.accent,COALESCE(cs.status,'active') status FROM clubs c
       LEFT JOIN club_settings cs ON cs.club_id=c.id WHERE c.id=?`,
      [match[1]]
    );
    if (!club) return send(res, 404, { error: 'Club not found.' });
    const member = await db.get('SELECT 1 FROM club_members WHERE club_id=? AND user_id=?', [club.id, user.id]);
    if (!member) return send(res, 403, { error: 'Join this club to open its chat.' });
    if (method === 'GET') return send(res, 200, { club, messages: await clubMessages(club.id) });
    if (method === 'POST') {
      if (club.status !== 'active') return send(res, 409, { error: 'This club is closed for new messages.' });
      if (!rate(req, `club-chat:${user.id}`, 30, 60000)) return send(res, 429, { error: 'You are sending messages too quickly.' });
      const input = await readBody(req);
      const body = clean(input.body, 1000);
      if (!body) return send(res, 400, { error: 'Write a message first.' });
      const messageId = id('cmsg');
      await db.run('INSERT INTO club_messages VALUES (?,?,?,?,?)', [messageId, club.id, user.id, body, now()]);
      broadcast('clubMessage', { clubId: club.id, messageId });
      return send(res, 201, { message: (await clubMessages(club.id)).find(message => message.id === messageId) });
    }
  }

  if (pathname === '/api/events' && method === 'GET') {
    return send(res, 200, { events: await listEvents(user.id) });
  }

  if (pathname === '/api/events' && method === 'POST') {
    const input = await readBody(req);
    if (!clean(input.title) || !input.startsAt) return send(res, 400, { error: 'Event title and date are required.' });
    const startsAt = new Date(input.startsAt);
    if (Number.isNaN(startsAt.getTime())) return send(res, 400, { error: 'Choose a valid event date.' });
    if (startsAt.getTime() <= Date.now()) return send(res, 400, { error: 'Event date must be in the future.' });
    const eventId = id('evt');
    await db.transaction(async tx => {
      await tx.run(
        'INSERT INTO events VALUES (?,?,?,?,?,?,?,?)',
        [
          eventId,
          user.id,
          clean(input.title, 100),
          clean(input.description, 800),
          startsAt.toISOString(),
          clean(input.location, 120),
          Math.min(5000, Math.max(2, Number(input.capacity) || 100)),
          now()
        ]
      );
      await tx.run('INSERT INTO event_attendees VALUES (?,?,?)', [eventId, user.id, now()]);
    });
    broadcast('event', { id: eventId });
    return send(res, 201, { event: (await listEvents(user.id)).find(item => item.id === eventId) });
  }

  match = pathname.match(/^\/api\/events\/([^/]+)\/rsvp$/);
  if (match && method === 'POST') {
    const event = await db.get(
      `SELECT e.*,(SELECT COUNT(*) FROM event_attendees WHERE event_id=e.id) attendees
       FROM events e WHERE e.id=?`,
      [match[1]]
    );
    if (!event) return send(res, 404, { error: 'Event not found.' });
    if (new Date(event.starts_at).getTime() <= Date.now()) return send(res, 409, { error: 'This event has already started.' });
    const exists = await db.get('SELECT 1 FROM event_attendees WHERE event_id=? AND user_id=?', [event.id, user.id]);
    if (exists) {
      if (event.creator_id === user.id) return send(res, 409, { error: 'The event creator remains counted as attending.' });
      await db.run('DELETE FROM event_attendees WHERE event_id=? AND user_id=?', [event.id, user.id]);
    } else {
      if (Number(event.attendees) >= Number(event.capacity)) return send(res, 409, { error: 'This event is full.' });
      await db.run('INSERT INTO event_attendees VALUES (?,?,?)', [event.id, user.id, now()]);
    }
    broadcast('event', { id: event.id });
    return send(res, 200, { going: !exists });
  }

  if (pathname === '/api/announcements' && method === 'GET') {
    return send(res, 200, { announcements: await listAnnouncements(user) });
  }

  if (pathname === '/api/announcements' && method === 'POST') {
    if (!requireRole(user, ['owner', 'management', 'faculty'])) {
      return send(res, 403, { error: 'Only faculty and management can publish announcements.' });
    }
    const input = await readBody(req);
    if (!clean(input.title) || !clean(input.body)) return send(res, 400, { error: 'Title and message are required.' });
    const announcementId = id('ann');
    await db.run(
      'INSERT INTO announcements VALUES (?,?,?,?,?,?)',
      [announcementId, user.id, clean(input.title, 120), clean(input.body, 1000), normalizeAudience(input.audience), now()]
    );
    broadcast('announcement', { id: announcementId });
    return send(res, 201, { ok: true });
  }

  if (pathname === '/api/issues' && method === 'POST') {
    const input = await readBody(req);
    if (!clean(input.subject) || !clean(input.description)) return send(res, 400, { error: 'Add a subject and explain the issue.' });
    const issueId = id('issue');
    const created = now();
    await db.transaction(async tx => {
      await tx.run(
        'INSERT INTO issues VALUES (?,?,?,?,?,?,?,?,?)',
        [issueId, user.id, clean(input.subject, 120), clean(input.description, 1200), clean(input.category, 40) || 'Other', 'open', '', created, created]
      );
      await tx.run(
        'INSERT INTO issue_messages VALUES (?,?,?,?,?,?)',
        [id('imsg'), issueId, user.id, clean(input.description, 1200), 'public', created]
      );
    });
    broadcast('issue', { id: issueId });
    return send(res, 201, { ok: true, id: issueId });
  }

  if (pathname === '/api/issues' && method === 'GET') {
    return send(res, 200, { issues: await issueRows(user) });
  }

  match = pathname.match(/^\/api\/issues\/([^/]+)$/);
  if (match && method === 'PATCH') {
    if (!requireRole(user, ['owner', 'management'])) return send(res, 403, { error: 'Management access required.' });
    const issue = await db.get('SELECT id FROM issues WHERE id=?', [match[1]]);
    if (!issue) return send(res, 404, { error: 'Issue not found.' });
    const input = await readBody(req);
    const status = ['open', 'in_progress', 'resolved'].includes(input.status) ? input.status : 'open';
    await db.run(
      'UPDATE issues SET status=?,admin_note=?,updated_at=? WHERE id=?',
      [status, clean(input.adminNote, 600), now(), match[1]]
    );
    broadcast('issue', { id: match[1] });
    return send(res, 200, { ok: true });
  }

  match = pathname.match(/^\/api\/issues\/([^/]+)\/messages$/);
  if (match && method === 'POST') {
    const issue = await db.get('SELECT * FROM issues WHERE id=?', [match[1]]);
    if (!issue) return send(res, 404, { error: 'Issue not found.' });
    const isStaff = requireRole(user, ['owner', 'management']);
    if (!isStaff && issue.reporter_id !== user.id) return send(res, 403, { error: 'You cannot reply to this issue.' });
    const input = await readBody(req);
    const body = clean(input.body, 1200);
    if (!body) return send(res, 400, { error: 'Reply cannot be empty.' });
    const visibility = isStaff && input.visibility === 'private' ? 'private' : 'public';
    await db.transaction(async tx => {
      await tx.run('INSERT INTO issue_messages VALUES (?,?,?,?,?,?)', [id('imsg'), issue.id, user.id, body, visibility, now()]);
      await tx.run('UPDATE issues SET updated_at=? WHERE id=?', [now(), issue.id]);
    });
    broadcast('issue', { id: issue.id });
    return send(res, 201, { ok: true });
  }

  if (pathname === '/api/admin/stats' && method === 'GET') {
    if (!requireRole(user, ['owner', 'management'])) return send(res, 403, { error: 'Management access required.' });
    const [users, posts, projects, clubs, events, openIssues, recentUsers] = await Promise.all([
      db.get('SELECT COUNT(*) n FROM users'),
      db.get('SELECT COUNT(*) n FROM posts'),
      db.get('SELECT COUNT(*) n FROM projects'),
      db.get('SELECT COUNT(*) n FROM clubs'),
      db.get('SELECT COUNT(*) n FROM events'),
      db.get("SELECT COUNT(*) n FROM issues WHERE status<>'resolved'"),
      db.all('SELECT * FROM users ORDER BY created_at DESC LIMIT 20')
    ]);
    return send(res, 200, {
      stats: {
        users: Number(users.n),
        posts: Number(posts.n),
        projects: Number(projects.n),
        clubs: Number(clubs.n),
        events: Number(events.n),
        openIssues: Number(openIssues.n)
      },
      recentUsers: recentUsers.map(managementUser)
    });
  }

  match = pathname.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
  if (match && method === 'PATCH') {
    if (user.role !== 'owner') return send(res, 403, { error: 'Owner access required.' });
    const target = await db.get('SELECT * FROM users WHERE id=?', [match[1]]);
    if (!target) return send(res, 404, { error: 'User not found.' });
    const input = await readBody(req);
    const role = ['student', 'faculty', 'management', 'owner'].includes(input.role) ? input.role : null;
    if (!role) return send(res, 400, { error: 'Choose a valid role.' });
    if (target.role === role) return send(res, 200, { ok: true, role });
    if (target.role === 'owner' && role !== 'owner') {
      const owners = await db.get("SELECT COUNT(*) n FROM users WHERE role='owner'");
      if (Number(owners.n) <= 1) return send(res, 409, { error: 'The last owner cannot be demoted.' });
    }
    await db.transaction(async tx => {
      await tx.run('UPDATE users SET role=? WHERE id=?', [role, target.id]);
      await tx.run(
        'INSERT INTO role_audit VALUES (?,?,?,?,?,?)',
        [id('role'), target.id, user.id, target.role, role, now()]
      );
    });
    broadcast('profile', { userId: target.id });
    return send(res, 200, { ok: true, role });
  }

  if (pathname === '/api/ai/assist' && method === 'POST') {
    if (!rate(req, `ai:${user.id}`, 20, 60000)) return send(res, 429, { error: 'AI rate limit reached. Try again shortly.' });
    const input = await readBody(req);
    if (!clean(input.text)) return send(res, 400, { error: 'Add text for the AI to work with.' });
    return send(res, 200, { result: await aiAssist(input, user) });
  }

  return send(res, 404, { error: 'Route not found.' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function staticFile(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.resolve(PUBLIC, `.${requested}`);
  if (!resolved.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
  const file = fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : path.join(PUBLIC, 'index.html');
  const fresh = file.endsWith('index.html') || file.endsWith('sw.js');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': fresh ? 'no-cache' : 'public,max-age=86400'
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  try {
    await ready;
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await api(req, res, url.pathname, url);
    else staticFile(res, url.pathname);
  } catch (error) {
    if (!error.status) console.error(error);
    if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Unexpected server error.' });
  }
});

async function start() {
  await ready;
  server.listen(PORT, HOST, () => console.log(`College Ox listening on http://${HOST}:${PORT}`));
}

if (require.main === module) {
  start().catch(error => {
    console.error(`Startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { server, db, ready, hashPassword, verifyPassword };
