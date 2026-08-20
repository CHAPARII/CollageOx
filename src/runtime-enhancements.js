const http = require('node:http');
const crypto = require('node:crypto');
const { createDatabase } = require('./db');

const db = createDatabase();
const originalCreateServer = http.createServer.bind(http);
const rateBuckets = new Map();

const now = () => new Date().toISOString();
const id = prefix => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
const clean = (value, max = 500) => String(value || '').trim().slice(0, max);
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
const pageLimit = (value, fallback = 20, max = 50) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(1, Math.floor(parsed))) : fallback;
};

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

function verifyPassword(password, stored = '') {
  const [salt, digest] = stored.split(':');
  if (!salt || digest?.length !== 64) return false;
  const candidate = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256');
  return crypto.timingSafeEqual(candidate, Buffer.from(digest, 'hex'));
}

function send(res, status, payload) {
  const out = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(out)
  });
  res.end(out);
}

function secureHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; }
  catch { return false; }
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

function rate(req, bucket, max, windowMs = 60000) {
  const key = `${bucket}:${req.socket.remoteAddress || 'local'}`;
  const time = Date.now();
  let item = rateBuckets.get(key);
  if (!item || item.reset < time) item = { count: 0, reset: time + windowMs };
  item.count++;
  rateBuckets.set(key, item);
  return item.count <= max;
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at || row.createdAt, id: row.id })).toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed.createdAt && parsed.id) return parsed;
  } catch {}
  return { createdAt: clean(value, 80), id: '\uffff' };
}

async function notify(userId, actorId, kind, entityId, text) {
  if (!userId || userId === actorId) return;
  await db.run(
    'INSERT INTO notifications (id,user_id,actor_id,kind,entity_id,text,created_at) VALUES (?,?,?,?,?,?,?)',
    [id('note'), userId, actorId || null, kind, entityId || '', clean(text, 240), now()]
  );
}

async function visiblePost(postId, viewerId) {
  return await db.get(
    `SELECT p.id,p.author_id,u.profile_visibility
     FROM posts p JOIN users u ON u.id=p.author_id
     WHERE p.id=? AND (u.profile_visibility<>'private' OR u.id=?)`,
    [postId, viewerId]
  );
}

async function commentsForPosts(postIds, perPost = 5) {
  const map = new Map(postIds.map(postId => [postId, []]));
  for (const postId of postIds) {
    const rows = await db.all(
      `SELECT * FROM (
        SELECT c.*,u.username,u.name,u.role,u.avatar,u.accent
        FROM comments c JOIN users u ON u.id=c.author_id
        WHERE c.post_id=? ORDER BY c.created_at DESC LIMIT ${pageLimit(perPost, 5, 20)}
       ) recent_comments ORDER BY created_at ASC`,
      [postId]
    );
    map.set(postId, rows);
  }
  return map;
}

async function postRows(userId, options = {}) {
  const { scope = 'all', postId = null, saved = false, cursor = null, limit = 20 } = options;
  const where = ["(u.profile_visibility<>'private' OR u.id=?)"];
  const params = [userId, userId, userId, userId];

  if (scope === 'following') {
    where.push('EXISTS(SELECT 1 FROM follows ff WHERE ff.follower_id=? AND ff.following_id=p.author_id)');
    params.push(userId);
  }
  if (postId) {
    where.push('p.id=?');
    params.push(postId);
  }
  if (saved) {
    where.push('EXISTS(SELECT 1 FROM saved_posts sp2 WHERE sp2.user_id=? AND sp2.post_id=p.id)');
    params.push(userId);
  }
  const decoded = decodeCursor(cursor);
  if (decoded?.createdAt) {
    where.push('(p.created_at<? OR (p.created_at=? AND p.id<?))');
    params.push(decoded.createdAt, decoded.createdAt, decoded.id);
  }

  const rows = await db.all(
    `SELECT p.*,u.username,u.name,u.role,u.avatar,u.accent,u.department,u.profile_visibility,
      (SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id AND r.kind='like') reaction_count,
      EXISTS(SELECT 1 FROM reactions r WHERE r.post_id=p.id AND r.user_id=? AND r.kind='like') reacted,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) comment_count,
      EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=? AND f.following_id=p.author_id) following_author,
      EXISTS(SELECT 1 FROM saved_posts sp WHERE sp.user_id=? AND sp.post_id=p.id) saved
     FROM posts p JOIN users u ON u.id=p.author_id
     WHERE ${where.join(' AND ')}
     ORDER BY p.created_at DESC,p.id DESC LIMIT ${pageLimit(limit, 20, 50)}`,
    params
  );

  if (!rows.length) return [];
  const commentsByPost = await commentsForPosts(rows.map(row => row.id), 5);
  return rows.map(row => ({
    id: row.id,
    body: row.body,
    type: row.type,
    tags: (() => { try { return JSON.parse(row.tags || '[]'); } catch { return []; } })(),
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

async function withLockedProject(projectId, task) {
  return db.transaction(async tx => {
    const suffix = db.kind === 'postgres' ? ' FOR UPDATE' : '';
    const project = await tx.get(`SELECT * FROM projects WHERE id=?${suffix}`, [projectId]);
    if (!project) return { error: [404, 'Project not found.'] };
    return task(tx, project);
  });
}

async function withLockedEvent(eventId, task) {
  return db.transaction(async tx => {
    const suffix = db.kind === 'postgres' ? ' FOR UPDATE' : '';
    const event = await tx.get(`SELECT * FROM events WHERE id=?${suffix}`, [eventId]);
    if (!event) return { error: [404, 'Event not found.'] };
    return task(tx, event);
  });
}

async function handleEnhanced(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const method = req.method;
  if (!pathname.startsWith('/api/')) return false;

  const exactEnhanced = pathname === '/api/notifications'
    || pathname === '/api/reports'
    || pathname === '/api/admin/reports'
    || pathname === '/api/admin/users'
    || pathname === '/api/admin/role-audit'
    || pathname === '/api/archive'
    || pathname === '/api/account'
    || pathname === '/api/announcements'
    || pathname === '/api/posts';
  const patternEnhanced = /^\/api\/posts\/[^/]+$/.test(pathname)
    || /^\/api\/posts\/[^/]+\/comments$/.test(pathname)
    || /^\/api\/posts\/[^/]+\/react$/.test(pathname)
    || /^\/api\/users\/[^/]+\/follow$/.test(pathname)
    || /^\/api\/projects\/[^/]+\/join$/.test(pathname)
    || /^\/api\/projects\/[^/]+\/transfer$/.test(pathname)
    || /^\/api\/clubs\/[^/]+\/transfer$/.test(pathname)
    || /^\/api\/events\/[^/]+$/.test(pathname)
    || /^\/api\/events\/[^/]+\/rsvp$/.test(pathname)
    || /^\/api\/issues\/[^/]+\/messages$/.test(pathname)
    || /^\/api\/admin\/reports\/[^/]+$/.test(pathname);

  if (!exactEnhanced && !patternEnhanced) return false;
  secureHeaders(res);
  if (method !== 'GET' && !originAllowed(req)) {
    send(res, 403, { error: 'Origin rejected' });
    return true;
  }

  const user = await currentUser(req);
  if (!user) {
    send(res, 401, { error: 'Sign in required.' });
    return true;
  }
  const staff = ['owner', 'management'].includes(user.role);

  if (pathname === '/api/posts' && method === 'GET') {
    const limit = pageLimit(url.searchParams.get('limit'), 20, 50);
    const scope = url.searchParams.get('scope') === 'following' ? 'following' : 'all';
    const saved = url.searchParams.get('saved') === '1';
    const posts = await postRows(user.id, { limit: limit + 1, cursor: url.searchParams.get('cursor'), scope, saved });
    const hasMore = posts.length > limit;
    const page = hasMore ? posts.slice(0, limit) : posts;
    send(res, 200, { posts: page, nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null });
    return true;
  }

  let match = pathname.match(/^\/api\/posts\/([^/]+)$/);
  if (match && method === 'GET') {
    const post = (await postRows(user.id, { postId: match[1], limit: 1 }))[0];
    send(res, post ? 200 : 404, post ? { post } : { error: 'Post not found.' });
    return true;
  }

  match = pathname.match(/^\/api\/posts\/([^/]+)\/comments$/);
  if (match && method === 'GET') {
    const post = await visiblePost(match[1], user.id);
    if (!post) {
      send(res, 404, { error: 'Post not found.' });
      return true;
    }
    const limit = pageLimit(url.searchParams.get('limit'), 20, 50);
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const comments = await db.all(
      `SELECT c.*,u.username,u.name,u.role,u.avatar,u.accent
       FROM comments c JOIN users u ON u.id=c.author_id
       WHERE c.post_id=? ORDER BY c.created_at ASC LIMIT ${limit} OFFSET ${Math.floor(offset)}`,
      [match[1]]
    );
    send(res, 200, {
      comments: comments.map(comment => ({
        id: comment.id,
        body: comment.body,
        createdAt: comment.created_at,
        author: { id: comment.author_id, username: comment.username, name: comment.name, role: comment.role, avatar: comment.avatar, accent: comment.accent }
      }))
    });
    return true;
  }

  if (match && method === 'POST') {
    const post = await visiblePost(match[1], user.id);
    if (!post) {
      send(res, 404, { error: 'Post not found.' });
      return true;
    }
    const input = await readBody(req);
    const body = clean(input.body, 600);
    if (!body) {
      send(res, 400, { error: 'Comment cannot be empty.' });
      return true;
    }
    await db.run('INSERT INTO comments VALUES (?,?,?,?,?)', [id('com'), post.id, user.id, body, now()]);
    await notify(post.author_id, user.id, 'comment', post.id, `${user.name} commented on your post.`);
    send(res, 201, { post: (await postRows(user.id, { postId: post.id, limit: 1 }))[0] });
    return true;
  }

  match = pathname.match(/^\/api\/posts\/([^/]+)\/react$/);
  if (match && method === 'POST') {
    const post = await visiblePost(match[1], user.id);
    if (!post) {
      send(res, 404, { error: 'Post not found.' });
      return true;
    }
    const existing = await db.get('SELECT 1 FROM reactions WHERE post_id=? AND user_id=?', [post.id, user.id]);
    if (existing) await db.run('DELETE FROM reactions WHERE post_id=? AND user_id=?', [post.id, user.id]);
    else {
      await db.run('INSERT INTO reactions VALUES (?,?,?)', [post.id, user.id, 'like']);
      await notify(post.author_id, user.id, 'like', post.id, `${user.name} liked your post.`);
    }
    send(res, 200, { post: (await postRows(user.id, { postId: post.id, limit: 1 }))[0] });
    return true;
  }

  match = pathname.match(/^\/api\/users\/([^/]+)\/follow$/);
  if (match && method === 'POST') {
    const target = await db.get('SELECT id,name FROM users WHERE id=?', [match[1]]);
    if (!target) {
      send(res, 404, { error: 'User not found.' });
      return true;
    }
    if (target.id === user.id) {
      send(res, 400, { error: 'You cannot follow yourself.' });
      return true;
    }
    const existing = await db.get('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?', [user.id, target.id]);
    if (existing) await db.run('DELETE FROM follows WHERE follower_id=? AND following_id=?', [user.id, target.id]);
    else {
      await db.run('INSERT INTO follows VALUES (?,?,?)', [user.id, target.id, now()]);
      await notify(target.id, user.id, 'follow', user.id, `${user.name} followed you.`);
    }
    send(res, 200, { following: !existing });
    return true;
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/join$/);
  if (match && method === 'POST') {
    const result = await withLockedProject(match[1], async (tx, project) => {
      const existing = await tx.get('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', [project.id, user.id]);
      if (existing) {
        if (project.owner_id === user.id) return { error: [409, 'The project owner cannot leave their own project.'] };
        await tx.run('DELETE FROM project_members WHERE project_id=? AND user_id=?', [project.id, user.id]);
        return { joined: false };
      }
      if (!['recruiting', 'active'].includes(project.status)) return { error: [409, 'This project is not accepting members.'] };
      const count = await tx.get('SELECT COUNT(*) n FROM project_members WHERE project_id=?', [project.id]);
      if (Number(count.n) >= Number(project.capacity)) return { error: [409, 'This team is full.'] };
      await tx.run('INSERT INTO project_members VALUES (?,?,?)', [project.id, user.id, now()]);
      await notify(project.owner_id, user.id, 'project_join', project.id, `${user.name} joined your project.`);
      return { joined: true };
    });
    if (result.error) send(res, result.error[0], { error: result.error[1] });
    else send(res, 200, { joined: result.joined });
    return true;
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/transfer$/);
  if (match && method === 'POST') {
    const project = await db.get('SELECT * FROM projects WHERE id=?', [match[1]]);
    if (!project) {
      send(res, 404, { error: 'Project not found.' });
      return true;
    }
    if (project.owner_id !== user.id && !staff) {
      send(res, 403, { error: 'Only the project owner or management can transfer ownership.' });
      return true;
    }
    const input = await readBody(req);
    const target = await db.get('SELECT id,username,name FROM users WHERE LOWER(username)=LOWER(?)', [clean(input.username, 24)]);
    if (!target) {
      send(res, 404, { error: 'New owner not found.' });
      return true;
    }
    const member = await db.get('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', [project.id, target.id]);
    if (!member) {
      send(res, 409, { error: 'The new owner must join the project first.' });
      return true;
    }
    await db.run('UPDATE projects SET owner_id=? WHERE id=?', [target.id, project.id]);
    await notify(target.id, user.id, 'project_owner', project.id, `You are now the owner of ${project.name}.`);
    send(res, 200, { ok: true, owner: { id: target.id, username: target.username, name: target.name } });
    return true;
  }

  match = pathname.match(/^\/api\/clubs\/([^/]+)\/transfer$/);
  if (match && method === 'POST') {
    const club = await db.get('SELECT * FROM clubs WHERE id=?', [match[1]]);
    if (!club) {
      send(res, 404, { error: 'Club not found.' });
      return true;
    }
    if (club.owner_id !== user.id && !staff) {
      send(res, 403, { error: 'Only the club owner or management can transfer ownership.' });
      return true;
    }
    const input = await readBody(req);
    const target = await db.get('SELECT id,username,name FROM users WHERE LOWER(username)=LOWER(?)', [clean(input.username, 24)]);
    if (!target) {
      send(res, 404, { error: 'New owner not found.' });
      return true;
    }
    const member = await db.get('SELECT 1 FROM club_members WHERE club_id=? AND user_id=?', [club.id, target.id]);
    if (!member) {
      send(res, 409, { error: 'The new owner must join the club first.' });
      return true;
    }
    await db.run('UPDATE clubs SET owner_id=? WHERE id=?', [target.id, club.id]);
    await notify(target.id, user.id, 'club_owner', club.id, `You are now the owner of ${club.name}.`);
    send(res, 200, { ok: true, owner: { id: target.id, username: target.username, name: target.name } });
    return true;
  }

  match = pathname.match(/^\/api\/events\/([^/]+)\/rsvp$/);
  if (match && method === 'POST') {
    const result = await withLockedEvent(match[1], async (tx, event) => {
      if (new Date(event.starts_at).getTime() <= Date.now()) return { error: [409, 'This event has already started.'] };
      const existing = await tx.get('SELECT 1 FROM event_attendees WHERE event_id=? AND user_id=?', [event.id, user.id]);
      if (existing) {
        if (event.creator_id === user.id) return { error: [409, 'The event creator remains counted as attending.'] };
        await tx.run('DELETE FROM event_attendees WHERE event_id=? AND user_id=?', [event.id, user.id]);
        return { going: false };
      }
      const count = await tx.get('SELECT COUNT(*) n FROM event_attendees WHERE event_id=?', [event.id]);
      if (Number(count.n) >= Number(event.capacity)) return { error: [409, 'This event is full.'] };
      await tx.run('INSERT INTO event_attendees VALUES (?,?,?)', [event.id, user.id, now()]);
      await notify(event.creator_id, user.id, 'event_rsvp', event.id, `${user.name} is going to your event.`);
      return { going: true };
    });
    if (result.error) send(res, result.error[0], { error: result.error[1] });
    else send(res, 200, { going: result.going });
    return true;
  }

  match = pathname.match(/^\/api\/events\/([^/]+)$/);
  if (match && method === 'PATCH') {
    const event = await db.get('SELECT * FROM events WHERE id=?', [match[1]]);
    if (!event) {
      send(res, 404, { error: 'Event not found.' });
      return true;
    }
    if (event.creator_id !== user.id && !staff) {
      send(res, 403, { error: 'Only the event creator or management can edit it.' });
      return true;
    }
    const input = await readBody(req);
    const title = clean(input.title, 100) || event.title;
    const description = input.description === undefined ? event.description : clean(input.description, 800);
    const location = input.location === undefined ? event.location : clean(input.location, 120);
    const starts = input.startsAt ? new Date(input.startsAt) : new Date(event.starts_at);
    if (Number.isNaN(starts.getTime()) || starts.getTime() <= Date.now()) {
      send(res, 400, { error: 'Choose a future event date.' });
      return true;
    }
    const attendeeCount = await db.get('SELECT COUNT(*) n FROM event_attendees WHERE event_id=?', [event.id]);
    const requestedCapacity = input.capacity === undefined ? Number(event.capacity) : Number(input.capacity);
    const capacity = Math.min(5000, Math.max(2, Number.isFinite(requestedCapacity) ? Math.floor(requestedCapacity) : Number(event.capacity)));
    if (capacity < Number(attendeeCount.n)) {
      send(res, 409, { error: `Capacity cannot be below the current ${attendeeCount.n} attendees.` });
      return true;
    }
    await db.run('UPDATE events SET title=?,description=?,starts_at=?,location=?,capacity=? WHERE id=?', [title, description, starts.toISOString(), location, capacity, event.id]);
    const attendees = await db.all('SELECT user_id FROM event_attendees WHERE event_id=? AND user_id<>?', [event.id, user.id]);
    for (const attendee of attendees) await notify(attendee.user_id, user.id, 'event_update', event.id, `${title} was updated.`);
    send(res, 200, { ok: true });
    return true;
  }

  if (match && method === 'DELETE') {
    const event = await db.get('SELECT * FROM events WHERE id=?', [match[1]]);
    if (!event) {
      send(res, 404, { error: 'Event not found.' });
      return true;
    }
    if (event.creator_id !== user.id && !staff) {
      send(res, 403, { error: 'Only the event creator or management can cancel it.' });
      return true;
    }
    const attendees = await db.all('SELECT user_id FROM event_attendees WHERE event_id=? AND user_id<>?', [event.id, user.id]);
    for (const attendee of attendees) await notify(attendee.user_id, user.id, 'event_cancelled', event.id, `${event.title} was cancelled.`);
    await db.run('DELETE FROM events WHERE id=?', [event.id]);
    send(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/announcements' && method === 'GET') {
    let rows;
    if (staff) {
      rows = await db.all(`SELECT a.*,u.username,u.name FROM announcements a JOIN users u ON u.id=a.author_id ORDER BY a.created_at DESC LIMIT 100`);
    } else {
      const roleAudience = user.role === 'faculty' ? 'Faculty' : 'Students';
      const departmentAudience = user.department ? `Department:${clean(user.department, 80)}` : '__none__';
      rows = await db.all(
        `SELECT a.*,u.username,u.name FROM announcements a JOIN users u ON u.id=a.author_id
         WHERE a.audience='Everyone' OR a.audience=? OR LOWER(a.audience)=LOWER(?)
         ORDER BY a.created_at DESC LIMIT 100`,
        [roleAudience, departmentAudience]
      );
    }
    send(res, 200, { announcements: rows });
    return true;
  }

  match = pathname.match(/^\/api\/issues\/([^/]+)\/messages$/);
  if (match && method === 'POST') {
    const issue = await db.get('SELECT * FROM issues WHERE id=?', [match[1]]);
    if (!issue) {
      send(res, 404, { error: 'Issue not found.' });
      return true;
    }
    const isStaff = staff;
    if (!isStaff && issue.reporter_id !== user.id) {
      send(res, 403, { error: 'You cannot reply to this issue.' });
      return true;
    }
    const input = await readBody(req);
    const body = clean(input.body, 1200);
    if (!body) {
      send(res, 400, { error: 'Reply cannot be empty.' });
      return true;
    }
    const visibility = isStaff && input.visibility === 'private' ? 'private' : 'public';
    await db.transaction(async tx => {
      await tx.run('INSERT INTO issue_messages VALUES (?,?,?,?,?,?)', [id('imsg'), issue.id, user.id, body, visibility, now()]);
      await tx.run('UPDATE issues SET updated_at=? WHERE id=?', [now(), issue.id]);
    });
    if (isStaff && visibility === 'public') await notify(issue.reporter_id, user.id, 'issue_reply', issue.id, 'Management replied to your support ticket.');
    send(res, 201, { ok: true });
    return true;
  }

  if (pathname === '/api/notifications' && method === 'GET') {
    const limit = pageLimit(url.searchParams.get('limit'), 40, 100);
    const rows = await db.all(
      `SELECT n.*,u.username actor_username,u.name actor_name
       FROM notifications n LEFT JOIN users u ON u.id=n.actor_id
       WHERE n.user_id=? ORDER BY n.created_at DESC LIMIT ${limit}`,
      [user.id]
    );
    const unread = await db.get('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL', [user.id]);
    send(res, 200, { notifications: rows, unread: Number(unread.n) });
    return true;
  }

  if (pathname === '/api/notifications' && method === 'POST') {
    const input = await readBody(req);
    if (input.all) await db.run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', [now(), user.id]);
    else if (input.id) await db.run('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?', [now(), clean(input.id, 80), user.id]);
    send(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/reports' && method === 'POST') {
    if (!rate(req, `report:${user.id}`, 10, 60000)) {
      send(res, 429, { error: 'Too many reports. Please wait a minute.' });
      return true;
    }
    const input = await readBody(req);
    const targetType = ['post', 'user'].includes(input.targetType) ? input.targetType : null;
    const targetId = clean(input.targetId, 100);
    const reason = clean(input.reason, 600);
    if (!targetType || !targetId || !reason) {
      send(res, 400, { error: 'Choose what you are reporting and add a reason.' });
      return true;
    }
    if (targetType === 'post' && !(await db.get('SELECT id FROM posts WHERE id=?', [targetId]))) {
      send(res, 404, { error: 'Post not found.' });
      return true;
    }
    if (targetType === 'user' && !(await db.get('SELECT id FROM users WHERE id=?', [targetId]))) {
      send(res, 404, { error: 'User not found.' });
      return true;
    }
    const duplicate = await db.get(`SELECT id FROM reports WHERE reporter_id=? AND target_type=? AND target_id=? AND status='open'`, [user.id, targetType, targetId]);
    if (duplicate) {
      send(res, 409, { error: 'You already have an open report for this item.' });
      return true;
    }
    const created = now();
    await db.run(
      'INSERT INTO reports (id,reporter_id,target_type,target_id,reason,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [id('report'), user.id, targetType, targetId, reason, 'open', created, created]
    );
    send(res, 201, { ok: true });
    return true;
  }

  if (pathname === '/api/admin/reports' && method === 'GET') {
    if (!staff) {
      send(res, 403, { error: 'Management access required.' });
      return true;
    }
    const status = ['open', 'resolved', 'dismissed'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'open';
    const reports = await db.all(
      `SELECT r.*,u.username reporter_username,u.name reporter_name
       FROM reports r JOIN users u ON u.id=r.reporter_id
       WHERE r.status=? ORDER BY r.created_at DESC LIMIT 100`,
      [status]
    );
    for (const report of reports) {
      if (report.target_type === 'post') {
        const target = await db.get(`SELECT p.body,u.username,u.name FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=?`, [report.target_id]);
        report.target = target ? { type: 'post', body: clean(target.body, 240), username: target.username, name: target.name } : null;
      } else {
        const target = await db.get('SELECT username,name,role FROM users WHERE id=?', [report.target_id]);
        report.target = target ? { type: 'user', ...target } : null;
      }
    }
    send(res, 200, { reports });
    return true;
  }

  match = pathname.match(/^\/api\/admin\/reports\/([^/]+)$/);
  if (match && method === 'PATCH') {
    if (!staff) {
      send(res, 403, { error: 'Management access required.' });
      return true;
    }
    const report = await db.get('SELECT * FROM reports WHERE id=?', [match[1]]);
    if (!report) {
      send(res, 404, { error: 'Report not found.' });
      return true;
    }
    const input = await readBody(req);
    const status = ['open', 'resolved', 'dismissed'].includes(input.status) ? input.status : report.status;
    await db.run('UPDATE reports SET status=?,review_note=?,reviewed_by=?,updated_at=? WHERE id=?', [status, clean(input.reviewNote, 600), user.id, now(), report.id]);
    send(res, 200, { ok: true, status });
    return true;
  }

  if (pathname === '/api/admin/users' && method === 'GET') {
    if (!staff) {
      send(res, 403, { error: 'Management access required.' });
      return true;
    }
    const q = clean(url.searchParams.get('q'), 60);
    const limit = pageLimit(url.searchParams.get('limit'), 30, 60);
    const params = [];
    let where = '';
    if (q) {
      const like = `%${q.toLowerCase()}%`;
      where = 'WHERE LOWER(username) LIKE ? OR LOWER(name) LIKE ? OR LOWER(department) LIKE ?';
      params.push(like, like, like);
    }
    const rows = await db.all(
      `SELECT id,username,name,role,department,created_at FROM users ${where}
       ORDER BY created_at DESC,id DESC LIMIT ${limit}`,
      params
    );
    send(res, 200, { users: rows });
    return true;
  }

  if (pathname === '/api/admin/role-audit' && method === 'GET') {
    if (!staff) {
      send(res, 403, { error: 'Management access required.' });
      return true;
    }
    const rows = await db.all(
      `SELECT r.*,target.username target_username,target.name target_name,actor.username actor_username,actor.name actor_name
       FROM role_audit r LEFT JOIN users target ON target.id=r.user_id LEFT JOIN users actor ON actor.id=r.actor_id
       ORDER BY r.created_at DESC LIMIT 100`
    );
    send(res, 200, { changes: rows });
    return true;
  }

  if (pathname === '/api/archive' && method === 'GET') {
    const kind = url.searchParams.get('kind');
    if (kind === 'projects') {
      const params = staff ? [] : [user.id];
      const rows = await db.all(
        `SELECT p.*,u.username,u.name,(SELECT COUNT(*) FROM project_members m WHERE m.project_id=p.id) members
         FROM projects p JOIN users u ON u.id=p.owner_id
         WHERE p.status='archived' ${staff ? '' : 'AND p.owner_id=?'} ORDER BY p.created_at DESC`,
        params
      );
      send(res, 200, { projects: rows.map(row => ({ ...row, members: Number(row.members), isOwner: row.owner_id === user.id })) });
      return true;
    }
    if (kind === 'clubs') {
      const params = staff ? [] : [user.id];
      const rows = await db.all(
        `SELECT c.*,u.username,COALESCE(cs.status,'active') status,(SELECT COUNT(*) FROM club_members m WHERE m.club_id=c.id) members
         FROM clubs c JOIN users u ON u.id=c.owner_id LEFT JOIN club_settings cs ON cs.club_id=c.id
         WHERE COALESCE(cs.status,'active')='archived' ${staff ? '' : 'AND c.owner_id=?'} ORDER BY c.created_at DESC`,
        params
      );
      send(res, 200, { clubs: rows.map(row => ({ ...row, members: Number(row.members), isOwner: row.owner_id === user.id })) });
      return true;
    }
    send(res, 400, { error: 'Choose projects or clubs.' });
    return true;
  }

  if (pathname === '/api/account' && method === 'DELETE') {
    const input = await readBody(req);
    if (!verifyPassword(String(input.password || ''), user.password_hash)) {
      send(res, 401, { error: 'Password is incorrect.' });
      return true;
    }
    if (clean(input.username, 24).toLowerCase() !== String(user.username).toLowerCase()) {
      send(res, 400, { error: 'Type your username to confirm account deletion.' });
      return true;
    }
    if (user.role === 'owner') {
      const owners = await db.get("SELECT COUNT(*) n FROM users WHERE role='owner'");
      if (Number(owners.n) <= 1) {
        send(res, 409, { error: 'The last owner cannot delete their account. Promote another owner first.' });
        return true;
      }
    }
    await db.run('DELETE FROM users WHERE id=?', [user.id]);
    res.setHeader('Set-Cookie', 'collegeox_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    send(res, 200, { ok: true });
    return true;
  }

  return false;
}

http.createServer = function patchedCreateServer(options, listener) {
  if (typeof options === 'function') {
    listener = options;
    options = undefined;
  }
  const wrapped = async (req, res) => {
    try {
      if (await handleEnhanced(req, res)) return;
    } catch (error) {
      if (!res.headersSent) {
        secureHeaders(res);
        send(res, error.status || 500, { error: error.status ? error.message : 'Unexpected server error.' });
      }
      if (!error.status) console.error(`Enhancement route failed: ${error.stack || error.message}`);
      return;
    }
    return listener(req, res);
  };
  const server = options === undefined ? originalCreateServer(wrapped) : originalCreateServer(options, wrapped);
  server.once('close', () => db.close().catch(() => {}));
  return server;
};

module.exports = { handleEnhanced, db };
