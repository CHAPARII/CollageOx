const { db, pageLimit, decodeCursor, encodeCursor, requireUser } = require('./common');
const { serializePost } = require('./social');

async function listPosts(userId, options = {}) {
  const limit = pageLimit(options.limit, 20, 50);
  const params = [userId, userId, userId, userId, userId];
  const where = [
    `(u.profile_visibility<>'private' OR u.id=?)`,
    `NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=? AND b.blocked_id=p.author_id) OR (b.blocker_id=p.author_id AND b.blocked_id=?))`,
    `NOT EXISTS(SELECT 1 FROM user_mutes mu WHERE mu.user_id=? AND mu.target_type='user' AND mu.target_id=p.author_id)`,
    `NOT EXISTS(
      SELECT 1 FROM post_contexts pc
      JOIN user_mutes cmu ON cmu.user_id=? AND cmu.target_type='club' AND cmu.target_id=pc.context_id
      WHERE pc.post_id=p.id AND pc.context_type='club'
    )`
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

function registerRoutes(registerRoute) {
  registerRoute('GET', '/api/posts', async ({ req, res, url }) => {
    const user = await requireUser(req);
    const scope = url.searchParams.get('scope') === 'following' ? 'following' : 'all';
    res.json(await listPosts(user.id, {
      limit: url.searchParams.get('limit'),
      cursor: url.searchParams.get('cursor'),
      scope,
      saved: url.searchParams.get('saved') === '1'
    }));
    return true;
  });
}

module.exports = { registerRoutes, listPosts };
