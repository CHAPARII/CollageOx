const {
  db,
  now,
  id,
  clean,
  json,
  readBody,
  requireUser,
  httpError,
  pageLimit,
  encodeCursor,
  decodeCursor,
  normalizeTag,
  publicUser
} = require('./common');
const { assertInteractionAllowed, isBlocked } = require('./safety');
const { notify, emitNotificationCount } = require('./notifications');
const { emit } = require('./event-hub');

const POST_TYPES = new Set(['post', 'question', 'collab', 'update', 'poll']);
const POLL_MODES = new Set(['single', 'multiple']);
const POLL_VISIBILITY = new Set(['anonymous', 'public']);

function parseMentions(text) {
  const found = new Set();
  const pattern = /(^|[^A-Za-z0-9_.-])@([A-Za-z0-9_.-]{2,24})/g;
  for (const match of String(text || '').matchAll(pattern)) found.add(match[2].toLowerCase());
  return [...found].slice(0, 30);
}

function parseHashtags(text) {
  const found = new Set();
  const pattern = /(^|\s)#([A-Za-z0-9_-]{1,50})/g;
  for (const match of String(text || '').matchAll(pattern)) {
    const tag = normalizeTag(match[2]);
    if (tag) found.add(tag);
  }
  return [...found].slice(0, 30);
}

async function indexTextMentionsAndHashtags({ sourceType, sourceId, authorId, text, tags = [] }) {
  const usernames = parseMentions(text);
  const tagSet = new Set([...parseHashtags(text), ...(Array.isArray(tags) ? tags.map(normalizeTag) : [])].filter(Boolean));
  const mentionedIds = [];
  await db.transaction(async tx => {
    await tx.run('DELETE FROM mentions WHERE source_type=? AND source_id=?', [sourceType, sourceId]);
    await tx.run('DELETE FROM content_hashtags WHERE source_type=? AND source_id=?', [sourceType, sourceId]);
    for (const username of usernames) {
      const target = await tx.get('SELECT id,username,name FROM users WHERE LOWER(username)=LOWER(?)', [username]);
      if (!target || target.id === authorId || await isBlocked(authorId, target.id)) continue;
      await tx.run(
        `INSERT INTO mentions (id,source_type,source_id,mentioned_user_id,author_id,created_at)
         VALUES (?,?,?,?,?,?) ON CONFLICT(source_type,source_id,mentioned_user_id) DO NOTHING`,
        [id('mention'), sourceType, sourceId, target.id, authorId, now()]
      );
      mentionedIds.push(target.id);
    }
    for (const tag of tagSet) {
      await tx.run(
        `INSERT INTO hashtags (tag,created_at) VALUES (?,?) ON CONFLICT(tag) DO NOTHING`,
        [tag, now()]
      );
      await tx.run(
        `INSERT INTO content_hashtags (tag,source_type,source_id,created_at)
         VALUES (?,?,?,?) ON CONFLICT(tag,source_type,source_id) DO NOTHING`,
        [tag, sourceType, sourceId, now()]
      );
    }
  });
  const author = await db.get('SELECT name FROM users WHERE id=?', [authorId]);
  for (const userId of mentionedIds) {
    await notify({
      userId,
      actorId: authorId,
      kind: 'mention',
      entityId: sourceId,
      text: `${author?.name || 'Someone'} mentioned you.`,
      category: 'mentions',
      dedupeKey: `${sourceType}:${sourceId}`
    });
  }
  if (mentionedIds.length) emitNotificationCount(mentionedIds);
  return { mentions: mentionedIds, hashtags: [...tagSet] };
}

async function contextAllowed(userId, contextType, contextId) {
  if (!contextType) return true;
  if (contextType === 'project') {
    return !!(await db.get('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', [contextId, userId]));
  }
  if (contextType === 'club') {
    const row = await db.get(
      `SELECT 1 FROM club_members m LEFT JOIN club_settings s ON s.club_id=m.club_id
       WHERE m.club_id=? AND m.user_id=? AND COALESCE(s.status,'active')='active'`,
      [contextId, userId]
    );
    return !!row;
  }
  return false;
}

async function pollForPost(postId, viewerId) {
  const poll = await db.get('SELECT * FROM polls WHERE post_id=?', [postId]);
  if (!poll) return null;
  const options = await db.all('SELECT * FROM poll_options WHERE poll_id=? ORDER BY position,id', [poll.id]);
  const selected = new Set((await db.all('SELECT option_id FROM poll_votes WHERE poll_id=? AND user_id=?', [poll.id, viewerId])).map(row => row.option_id));
  const serialized = [];
  for (const option of options) {
    const count = await db.get('SELECT COUNT(*) n FROM poll_votes WHERE poll_id=? AND option_id=?', [poll.id, option.id]);
    const item = {
      id: option.id,
      label: option.label,
      position: Number(option.position),
      votes: Number(count.n),
      selected: selected.has(option.id)
    };
    if (poll.voter_visibility === 'public') {
      const voters = await db.all(
        `SELECT u.id,u.username,u.name,u.role,u.avatar,u.accent
         FROM poll_votes v JOIN users u ON u.id=v.user_id
         WHERE v.poll_id=? AND v.option_id=? ORDER BY v.created_at ASC LIMIT 100`,
        [poll.id, option.id]
      );
      item.voters = voters.map(publicUser);
    }
    serialized.push(item);
  }
  const total = await db.get('SELECT COUNT(DISTINCT user_id) n FROM poll_votes WHERE poll_id=?', [poll.id]);
  return {
    id: poll.id,
    choiceMode: poll.choice_mode,
    voterVisibility: poll.voter_visibility,
    expiresAt: poll.expires_at,
    expired: new Date(poll.expires_at).getTime() <= Date.now(),
    totalVoters: Number(total.n),
    options: serialized
  };
}

async function mediaForPost(postId) {
  const rows = await db.all(
    `SELECT m.id,m.mime_type,m.data,m.width,m.height,pm.position
     FROM post_media pm JOIN media m ON m.id=pm.media_id
     WHERE pm.post_id=? ORDER BY pm.position`,
    [postId]
  );
  return rows.map(row => ({ id: row.id, mimeType: row.mime_type, src: row.data, width: row.width, height: row.height, position: Number(row.position) }));
}

async function serializePost(row, viewerId) {
  const [reactionCount, commentCount, reacted, followed, saved, comments, context, poll, media] = await Promise.all([
    db.get("SELECT COUNT(*) n FROM reactions WHERE post_id=? AND kind='like'", [row.id]),
    db.get('SELECT COUNT(*) n FROM comments WHERE post_id=?', [row.id]),
    db.get("SELECT 1 FROM reactions WHERE post_id=? AND user_id=? AND kind='like'", [row.id, viewerId]),
    db.get('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?', [viewerId, row.author_id]),
    db.get('SELECT 1 FROM saved_posts WHERE user_id=? AND post_id=?', [viewerId, row.id]),
    db.all(
      `SELECT c.*,u.username,u.name,u.role,u.avatar,u.accent
       FROM comments c JOIN users u ON u.id=c.author_id
       WHERE c.post_id=? ORDER BY c.created_at DESC LIMIT 5`,
      [row.id]
    ),
    db.get('SELECT context_type,context_id FROM post_contexts WHERE post_id=?', [row.id]),
    pollForPost(row.id, viewerId),
    mediaForPost(row.id)
  ]);
  const author = row.username ? row : await db.get('SELECT * FROM users WHERE id=?', [row.author_id]);
  return {
    id: row.id,
    body: row.body,
    type: row.type,
    tags: json(row.tags, []),
    createdAt: row.created_at,
    editedAt: row.edited_at,
    reactionCount: Number(reactionCount.n),
    reacted: !!reacted,
    commentCount: Number(commentCount.n),
    followingAuthor: !!followed,
    saved: !!saved,
    author: publicUser(author),
    comments: comments.reverse().map(comment => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.created_at,
      author: publicUser(comment)
    })),
    context: context ? { type: context.context_type, id: context.context_id } : null,
    poll,
    media
  };
}

async function visiblePost(postId, viewerId) {
  const row = await db.get(
    `SELECT p.*,u.username,u.name,u.role,u.avatar,u.accent,u.department,u.profile_visibility
     FROM posts p JOIN users u ON u.id=p.author_id
     WHERE p.id=? AND (u.profile_visibility<>'private' OR u.id=?)`,
    [postId, viewerId]
  );
  if (!row || await isBlocked(viewerId, row.author_id)) return null;
  return row;
}

async function listPosts(userId, options = {}) {
  const limit = pageLimit(options.limit, 20, 50);
  const params = [userId, userId, userId, userId, userId];
  const where = [
    `(u.profile_visibility<>'private' OR u.id=?)`,
    `NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=? AND b.blocked_id=p.author_id) OR (b.blocker_id=p.author_id AND b.blocked_id=?))`,
    `NOT EXISTS(SELECT 1 FROM user_mutes mu WHERE mu.user_id=? AND mu.target_type='user' AND mu.target_id=p.author_id)`
  ];
  if (options.postId) {
    where.push('p.id=?');
    params.push(options.postId);
  }
  if (options.scope === 'following') {
    where.push('EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=? AND f.following_id=p.author_id)');
    params.push(userId);
  }
  if (options.saved) {
    where.push('EXISTS(SELECT 1 FROM saved_posts sp WHERE sp.user_id=? AND sp.post_id=p.id)');
    params.push(userId);
  }
  const cursor = decodeCursor(options.cursor);
  if (cursor) {
    where.push('(p.created_at<? OR (p.created_at=? AND p.id<?))');
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const rows = await db.all(
    `SELECT p.*,u.username,u.name,u.role,u.avatar,u.accent,u.department,u.profile_visibility
     FROM posts p JOIN users u ON u.id=p.author_id
     WHERE ${where.join(' AND ')}
     ORDER BY p.created_at DESC,p.id DESC LIMIT ${limit + 1}`,
    params
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const posts = [];
  for (const row of page) posts.push(await serializePost(row, userId));
  return { posts, nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null };
}

async function createPoll(tx, postId, input) {
  const options = (Array.isArray(input?.options) ? input.options : []).map(value => clean(value, 120)).filter(Boolean);
  const unique = [...new Map(options.map(value => [value.toLowerCase(), value])).values()].slice(0, 8);
  if (unique.length < 2) throw httpError(400, 'Add at least two poll options.');
  const choiceMode = POLL_MODES.has(input.choiceMode) ? input.choiceMode : 'single';
  const voterVisibility = POLL_VISIBILITY.has(input.voterVisibility) ? input.voterVisibility : 'anonymous';
  const expires = new Date(input.expiresAt);
  if (Number.isNaN(expires.getTime()) || expires.getTime() <= Date.now()) throw httpError(400, 'Choose a future poll expiry.');
  const pollId = id('poll');
  await tx.run(
    'INSERT INTO polls (id,post_id,choice_mode,voter_visibility,expires_at,created_at) VALUES (?,?,?,?,?,?)',
    [pollId, postId, choiceMode, voterVisibility, expires.toISOString(), now()]
  );
  for (let position = 0; position < unique.length; position++) {
    await tx.run(
      'INSERT INTO poll_options (id,poll_id,label,position) VALUES (?,?,?,?)',
      [id('popt'), pollId, unique[position], position]
    );
  }
  return pollId;
}

async function authorizePin(user, contextType, contextId, postId) {
  const post = await db.get('SELECT * FROM posts WHERE id=?', [postId]);
  if (!post) throw httpError(404, 'Post not found.');
  if (contextType === 'profile') {
    if (contextId !== user.id || post.author_id !== user.id) throw httpError(403, 'You can only pin your own post.');
    return;
  }
  if (contextType === 'project') {
    const project = await db.get('SELECT owner_id FROM projects WHERE id=?', [contextId]);
    const context = await db.get("SELECT 1 FROM post_contexts WHERE post_id=? AND context_type='project' AND context_id=?", [postId, contextId]);
    if (!project || !context || project.owner_id !== user.id) throw httpError(403, 'Only the project owner can pin project updates.');
    return;
  }
  if (contextType === 'club') {
    const club = await db.get('SELECT owner_id FROM clubs WHERE id=?', [contextId]);
    const role = await db.get('SELECT role FROM club_member_roles WHERE club_id=? AND user_id=?', [contextId, user.id]);
    const context = await db.get("SELECT 1 FROM post_contexts WHERE post_id=? AND context_type='club' AND context_id=?", [postId, contextId]);
    if (!club || !context || (club.owner_id !== user.id && role?.role !== 'Admin')) throw httpError(403, 'Only the club owner or admin can pin club posts.');
    return;
  }
  throw httpError(400, 'Unsupported pin context.');
}

function registerRoutes(registerRoute) {
  registerRoute('GET', '/api/posts', async ({ req, res, url }) => {
    const user = await requireUser(req);
    const scope = url.searchParams.get('scope') === 'following' ? 'following' : 'all';
    const result = await listPosts(user.id, {
      limit: url.searchParams.get('limit'),
      cursor: url.searchParams.get('cursor'),
      scope,
      saved: url.searchParams.get('saved') === '1'
    });
    res.json(result);
    return true;
  });

  registerRoute('POST', '/api/posts', async ({ req, res }) => {
    const user = await requireUser(req);
    const input = await readBody(req, 900000);
    const body = clean(input.body, 1800);
    if (!body) throw httpError(400, 'Write something before publishing.');
    const type = POST_TYPES.has(input.type) ? input.type : 'post';
    const tags = [...new Set((Array.isArray(input.tags) ? input.tags : []).map(normalizeTag).filter(Boolean))].slice(0, 8);
    const contextType = ['project', 'club'].includes(input.context?.type) ? input.context.type : null;
    const contextId = contextType ? clean(input.context.id, 120) : null;
    if (contextType && !(await contextAllowed(user.id, contextType, contextId))) throw httpError(403, 'Join this community before posting there.');
    if (type === 'poll' && !input.poll) throw httpError(400, 'Add poll options.');
    const postId = id('post');
    const createdAt = now();
    await db.transaction(async tx => {
      await tx.run(
        'INSERT INTO posts (id,author_id,body,type,tags,created_at,edited_at) VALUES (?,?,?,?,?,?,?)',
        [postId, user.id, body, type, JSON.stringify(tags), createdAt, null]
      );
      if (contextType) await tx.run('INSERT INTO post_contexts (post_id,context_type,context_id,created_at) VALUES (?,?,?,?)', [postId, contextType, contextId, createdAt]);
      if (type === 'poll') await createPoll(tx, postId, input.poll);
    });
    await indexTextMentionsAndHashtags({ sourceType: 'post', sourceId: postId, authorId: user.id, text: body, tags });
    emit('post', { id: postId, authorId: user.id, contextType, contextId });
    const row = await visiblePost(postId, user.id);
    res.json({ post: await serializePost(row, user.id) }, 201);
    return true;
  });

  registerRoute('GET', /^\/api\/posts\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const row = await visiblePost(decodeURIComponent(match[1]), user.id);
    if (!row) throw httpError(404, 'Post not found.');
    res.json({ post: await serializePost(row, user.id) });
    return true;
  });

  registerRoute('PATCH', /^\/api\/posts\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const postId = decodeURIComponent(match[1]);
    const row = await db.get('SELECT * FROM posts WHERE id=?', [postId]);
    if (!row) throw httpError(404, 'Post not found.');
    if (row.author_id !== user.id) throw httpError(403, 'You can only edit your own posts.');
    const input = await readBody(req);
    const body = input.body === undefined ? row.body : clean(input.body, 1800);
    if (!body) throw httpError(400, 'Post cannot be empty.');
    const type = input.type === undefined ? row.type : (POST_TYPES.has(input.type) ? input.type : row.type);
    if (row.type === 'poll' && type !== 'poll') throw httpError(409, 'A poll post must remain a poll.');
    const tags = input.tags === undefined ? json(row.tags, []) : [...new Set((Array.isArray(input.tags) ? input.tags : []).map(normalizeTag).filter(Boolean))].slice(0, 8);
    await db.run('UPDATE posts SET body=?,type=?,tags=?,edited_at=? WHERE id=?', [body, type, JSON.stringify(tags), now(), postId]);
    await indexTextMentionsAndHashtags({ sourceType: 'post', sourceId: postId, authorId: user.id, text: body, tags });
    emit('post', { id: postId, edited: true });
    const updated = await visiblePost(postId, user.id);
    res.json({ post: await serializePost(updated, user.id) });
    return true;
  });

  registerRoute('GET', /^\/api\/posts\/([^/]+)\/comments$/, async ({ req, res, url, match }) => {
    const user = await requireUser(req);
    const row = await visiblePost(decodeURIComponent(match[1]), user.id);
    if (!row) throw httpError(404, 'Post not found.');
    const limit = pageLimit(url.searchParams.get('limit'), 30, 80);
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const comments = await db.all(
      `SELECT c.*,u.username,u.name,u.role,u.avatar,u.accent
       FROM comments c JOIN users u ON u.id=c.author_id
       WHERE c.post_id=? ORDER BY c.created_at ASC LIMIT ${limit} OFFSET ${Math.floor(offset)}`,
      [row.id]
    );
    res.json({ comments: comments.map(comment => ({ id: comment.id, body: comment.body, createdAt: comment.created_at, author: publicUser(comment) })) });
    return true;
  });

  registerRoute('POST', /^\/api\/posts\/([^/]+)\/comments$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const row = await visiblePost(decodeURIComponent(match[1]), user.id);
    if (!row) throw httpError(404, 'Post not found.');
    await assertInteractionAllowed(user.id, row.author_id);
    const input = await readBody(req);
    const body = clean(input.body, 600);
    if (!body) throw httpError(400, 'Comment cannot be empty.');
    const commentId = id('com');
    await db.run('INSERT INTO comments (id,post_id,author_id,body,created_at) VALUES (?,?,?,?,?)', [commentId, row.id, user.id, body, now()]);
    await notify({ userId: row.author_id, actorId: user.id, kind: 'comment', entityId: row.id, text: `${user.name} commented on your post.`, category: 'social' });
    await indexTextMentionsAndHashtags({ sourceType: 'comment', sourceId: commentId, authorId: user.id, text: body });
    emit('comment', { postId: row.id, commentId });
    res.json({ post: await serializePost(row, user.id) }, 201);
    return true;
  });

  registerRoute('POST', /^\/api\/posts\/([^/]+)\/react$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const row = await visiblePost(decodeURIComponent(match[1]), user.id);
    if (!row) throw httpError(404, 'Post not found.');
    await assertInteractionAllowed(user.id, row.author_id);
    const existing = await db.get('SELECT 1 FROM reactions WHERE post_id=? AND user_id=?', [row.id, user.id]);
    if (existing) await db.run('DELETE FROM reactions WHERE post_id=? AND user_id=?', [row.id, user.id]);
    else {
      await db.run('INSERT INTO reactions (post_id,user_id,kind) VALUES (?,?,?)', [row.id, user.id, 'like']);
      await notify({ userId: row.author_id, actorId: user.id, kind: 'like', entityId: row.id, text: `${user.name} liked your post.`, category: 'social' });
    }
    emit('reaction', { postId: row.id });
    res.json({ post: await serializePost(row, user.id) });
    return true;
  });

  registerRoute('POST', /^\/api\/users\/([^/]+)\/follow$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const targetId = decodeURIComponent(match[1]);
    if (targetId === user.id) throw httpError(400, 'You cannot follow yourself.');
    const target = await db.get('SELECT id,name FROM users WHERE id=?', [targetId]);
    if (!target) throw httpError(404, 'User not found.');
    await assertInteractionAllowed(user.id, targetId);
    const existing = await db.get('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?', [user.id, targetId]);
    if (existing) await db.run('DELETE FROM follows WHERE follower_id=? AND following_id=?', [user.id, targetId]);
    else {
      await db.run('INSERT INTO follows (follower_id,following_id,created_at) VALUES (?,?,?)', [user.id, targetId, now()]);
      await notify({ userId: targetId, actorId: user.id, kind: 'follow', entityId: user.id, text: `${user.name} followed you.`, category: 'social' });
    }
    emit('follow', { followerId: user.id, followingId: targetId, following: !existing });
    res.json({ following: !existing });
    return true;
  });

  registerRoute('GET', /^\/api\/polls\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const poll = await db.get('SELECT * FROM polls WHERE id=?', [decodeURIComponent(match[1])]);
    if (!poll) throw httpError(404, 'Poll not found.');
    const post = await visiblePost(poll.post_id, user.id);
    if (!post) throw httpError(404, 'Poll not found.');
    res.json({ poll: await pollForPost(post.id, user.id) });
    return true;
  });

  registerRoute('POST', /^\/api\/polls\/([^/]+)\/vote$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const poll = await db.get('SELECT * FROM polls WHERE id=?', [decodeURIComponent(match[1])]);
    if (!poll) throw httpError(404, 'Poll not found.');
    const post = await visiblePost(poll.post_id, user.id);
    if (!post) throw httpError(404, 'Poll not found.');
    await assertInteractionAllowed(user.id, post.author_id);
    if (new Date(poll.expires_at).getTime() <= Date.now()) throw httpError(409, 'Voting has closed.');
    const input = await readBody(req);
    const optionIds = [...new Set((Array.isArray(input.optionIds) ? input.optionIds : []).map(value => clean(value, 120)).filter(Boolean))];
    if (!optionIds.length) throw httpError(400, 'Choose an option.');
    if (poll.choice_mode === 'single' && optionIds.length !== 1) throw httpError(400, 'Choose one option for this poll.');
    const valid = await db.all(`SELECT id FROM poll_options WHERE poll_id=?`, [poll.id]);
    const validIds = new Set(valid.map(row => row.id));
    if (optionIds.some(optionId => !validIds.has(optionId))) throw httpError(400, 'Invalid poll option.');
    await db.transaction(async tx => {
      await tx.run('DELETE FROM poll_votes WHERE poll_id=? AND user_id=?', [poll.id, user.id]);
      for (const optionId of optionIds) await tx.run('INSERT INTO poll_votes (poll_id,option_id,user_id,created_at) VALUES (?,?,?,?)', [poll.id, optionId, user.id, now()]);
    });
    emit('poll_update', { pollId: poll.id, postId: poll.post_id });
    res.json({ poll: await pollForPost(poll.post_id, user.id) });
    return true;
  });

  registerRoute('GET', /^\/api\/hashtags\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const tag = normalizeTag(decodeURIComponent(match[1]));
    if (!tag) throw httpError(400, 'Invalid hashtag.');
    const ids = await db.all("SELECT source_id FROM content_hashtags WHERE tag=? AND source_type='post' ORDER BY created_at DESC LIMIT 80", [tag]);
    const posts = [];
    for (const item of ids) {
      const row = await visiblePost(item.source_id, user.id);
      if (row) posts.push(await serializePost(row, user.id));
      if (posts.length >= 30) break;
    }
    const needle = `%${tag.toLowerCase()}%`;
    const [projects, clubs, events] = await Promise.all([
      db.all("SELECT id,name,pitch,status FROM projects WHERE status<>'archived' AND (LOWER(name) LIKE ? OR LOWER(pitch) LIKE ? OR LOWER(skills) LIKE ?) ORDER BY created_at DESC LIMIT 20", [needle, needle, needle]),
      db.all("SELECT c.id,c.name,c.description,c.category FROM clubs c LEFT JOIN club_settings s ON s.club_id=c.id WHERE COALESCE(s.status,'active')<>'archived' AND (LOWER(c.name) LIKE ? OR LOWER(c.description) LIKE ? OR LOWER(c.category) LIKE ?) ORDER BY c.created_at DESC LIMIT 20", [needle, needle, needle]),
      db.all("SELECT id,title,description,starts_at,location FROM events WHERE starts_at>? AND (LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(location) LIKE ?) ORDER BY starts_at ASC LIMIT 20", [now(), needle, needle, needle])
    ]);
    res.json({ tag, posts, projects, clubs, events });
    return true;
  });

  registerRoute('PUT', /^\/api\/pins\/(profile|project|club)\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const contextType = match[1];
    const contextId = decodeURIComponent(match[2]);
    const input = await readBody(req);
    const postId = clean(input.postId, 120);
    await authorizePin(user, contextType, contextId, postId);
    await db.run(
      `INSERT INTO pinned_posts (context_type,context_id,post_id,pinned_by,created_at)
       VALUES (?,?,?,?,?) ON CONFLICT(context_type,context_id) DO UPDATE SET post_id=excluded.post_id,pinned_by=excluded.pinned_by,created_at=excluded.created_at`,
      [contextType, contextId, postId, user.id, now()]
    );
    res.json({ ok: true, postId });
    return true;
  });

  registerRoute('DELETE', /^\/api\/pins\/(profile|project|club)\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const contextType = match[1];
    const contextId = decodeURIComponent(match[2]);
    const pin = await db.get('SELECT post_id FROM pinned_posts WHERE context_type=? AND context_id=?', [contextType, contextId]);
    if (!pin) return res.json({ ok: true });
    await authorizePin(user, contextType, contextId, pin.post_id);
    await db.run('DELETE FROM pinned_posts WHERE context_type=? AND context_id=?', [contextType, contextId]);
    res.json({ ok: true });
    return true;
  });

  registerRoute('GET', '/api/bookmark-collections', async ({ req, res }) => {
    const user = await requireUser(req);
    const rows = await db.all(
      `SELECT c.id,c.name,c.created_at,(SELECT COUNT(*) FROM bookmark_collection_posts p WHERE p.collection_id=c.id) item_count
       FROM bookmark_collections c WHERE c.user_id=? ORDER BY c.created_at DESC`,
      [user.id]
    );
    res.json({ collections: rows.map(row => ({ id: row.id, name: row.name, createdAt: row.created_at, itemCount: Number(row.item_count) })) });
    return true;
  });

  registerRoute('POST', '/api/bookmark-collections', async ({ req, res }) => {
    const user = await requireUser(req);
    const input = await readBody(req);
    const name = clean(input.name, 60);
    if (!name) throw httpError(400, 'Add a collection name.');
    const existing = await db.get('SELECT id FROM bookmark_collections WHERE user_id=? AND LOWER(name)=LOWER(?)', [user.id, name]);
    if (existing) throw httpError(409, 'A collection with that name already exists.');
    const collectionId = id('collection');
    await db.run('INSERT INTO bookmark_collections (id,user_id,name,created_at) VALUES (?,?,?,?)', [collectionId, user.id, name, now()]);
    res.json({ collection: { id: collectionId, name, itemCount: 0 } }, 201);
    return true;
  });

  registerRoute('DELETE', /^\/api\/bookmark-collections\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const result = await db.run('DELETE FROM bookmark_collections WHERE id=? AND user_id=?', [decodeURIComponent(match[1]), user.id]);
    if (!result.rowCount) throw httpError(404, 'Collection not found.');
    res.json({ ok: true });
    return true;
  });

  registerRoute('PUT', /^\/api\/bookmark-collections\/([^/]+)\/posts\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const collection = await db.get('SELECT id FROM bookmark_collections WHERE id=? AND user_id=?', [decodeURIComponent(match[1]), user.id]);
    if (!collection) throw httpError(404, 'Collection not found.');
    const postId = decodeURIComponent(match[2]);
    const post = await visiblePost(postId, user.id);
    if (!post) throw httpError(404, 'Post not found.');
    await db.transaction(async tx => {
      await tx.run(`INSERT INTO saved_posts (user_id,post_id,created_at) VALUES (?,?,?) ON CONFLICT(user_id,post_id) DO NOTHING`, [user.id, postId, now()]);
      await tx.run(`INSERT INTO bookmark_collection_posts (collection_id,post_id,created_at) VALUES (?,?,?) ON CONFLICT(collection_id,post_id) DO NOTHING`, [collection.id, postId, now()]);
    });
    res.json({ ok: true });
    return true;
  });

  registerRoute('DELETE', /^\/api\/bookmark-collections\/([^/]+)\/posts\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const collection = await db.get('SELECT id FROM bookmark_collections WHERE id=? AND user_id=?', [decodeURIComponent(match[1]), user.id]);
    if (!collection) throw httpError(404, 'Collection not found.');
    await db.run('DELETE FROM bookmark_collection_posts WHERE collection_id=? AND post_id=?', [collection.id, decodeURIComponent(match[2])]);
    res.json({ ok: true });
    return true;
  });
}

module.exports = {
  registerRoutes,
  parseMentions,
  parseHashtags,
  indexTextMentionsAndHashtags,
  pollForPost,
  serializePost,
  visiblePost,
  listPosts,
  contextAllowed
};
