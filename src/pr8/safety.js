const { db, now, clean, readBody, requireUser, httpError, bool } = require('./common');
const { emit } = require('./event-hub');

async function isBlocked(a, b) {
  if (!a || !b || a === b) return false;
  return !!(await db.get(
    `SELECT 1 FROM user_blocks
     WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)
     LIMIT 1`,
    [a, b, b, a]
  ));
}

async function assertInteractionAllowed(a, b) {
  if (await isBlocked(a, b)) throw httpError(403, 'This interaction is unavailable.');
}

async function blockUser(blockerId, blockedId) {
  if (!blockerId || !blockedId || blockerId === blockedId) throw httpError(400, 'You cannot block yourself.');
  const target = await db.get('SELECT id FROM users WHERE id=?', [blockedId]);
  if (!target) throw httpError(404, 'User not found.');
  await db.transaction(async tx => {
    await tx.run(
      `INSERT INTO user_blocks (blocker_id,blocked_id,created_at) VALUES (?,?,?)
       ON CONFLICT(blocker_id,blocked_id) DO NOTHING`,
      [blockerId, blockedId, now()]
    );
    await tx.run(
      'DELETE FROM follows WHERE (follower_id=? AND following_id=?) OR (follower_id=? AND following_id=?)',
      [blockerId, blockedId, blockedId, blockerId]
    );
  });
  emit('block_changed', { blockerId, blockedId, blocked: true }, [blockerId, blockedId]);
}

async function unblockUser(blockerId, blockedId) {
  await db.run('DELETE FROM user_blocks WHERE blocker_id=? AND blocked_id=?', [blockerId, blockedId]);
  emit('block_changed', { blockerId, blockedId, blocked: false }, [blockerId, blockedId]);
}

async function setMute(userId, targetType, targetId, muted) {
  const type = clean(targetType, 30).toLowerCase();
  const allowed = new Set(['user', 'club', 'dm', 'notification']);
  if (!allowed.has(type)) throw httpError(400, 'Unsupported mute type.');
  const id = clean(targetId, 120);
  if (!id) throw httpError(400, 'Choose something to mute.');
  if (muted) {
    await db.run(
      `INSERT INTO user_mutes (user_id,target_type,target_id,created_at) VALUES (?,?,?,?)
       ON CONFLICT(user_id,target_type,target_id) DO NOTHING`,
      [userId, type, id, now()]
    );
  } else {
    await db.run('DELETE FROM user_mutes WHERE user_id=? AND target_type=? AND target_id=?', [userId, type, id]);
  }
  return !!muted;
}

async function isMuted(userId, targetType, targetId) {
  return !!(await db.get(
    'SELECT 1 FROM user_mutes WHERE user_id=? AND target_type=? AND target_id=?',
    [userId, clean(targetType, 30).toLowerCase(), clean(targetId, 120)]
  ));
}

async function mutedTargets(userId, targetType) {
  return new Set((await db.all(
    'SELECT target_id FROM user_mutes WHERE user_id=? AND target_type=?',
    [userId, clean(targetType, 30).toLowerCase()]
  )).map(row => row.target_id));
}

function registerRoutes(registerRoute) {
  registerRoute('GET', '/api/safety/blocks', async ({ req, res }) => {
    const user = await requireUser(req);
    const rows = await db.all(
      `SELECT b.blocked_id,u.username,u.name,u.role,u.avatar,u.accent,b.created_at
       FROM user_blocks b JOIN users u ON u.id=b.blocked_id
       WHERE b.blocker_id=? ORDER BY b.created_at DESC`,
      [user.id]
    );
    res.json({ blocks: rows.map(row => ({
      id: row.blocked_id,
      username: row.username,
      name: row.name,
      role: row.role,
      avatar: row.avatar || '',
      accent: row.accent || '#155eef',
      createdAt: row.created_at
    })) });
    return true;
  });

  registerRoute('PUT', /^\/api\/safety\/blocks\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    await blockUser(user.id, decodeURIComponent(match[1]));
    res.json({ blocked: true });
    return true;
  });

  registerRoute('DELETE', /^\/api\/safety\/blocks\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    await unblockUser(user.id, decodeURIComponent(match[1]));
    res.json({ blocked: false });
    return true;
  });

  registerRoute('PATCH', '/api/safety/mutes', async ({ req, res }) => {
    const user = await requireUser(req);
    const input = await readBody(req);
    const muted = await setMute(user.id, input.targetType, input.targetId, bool(input.muted));
    res.json({ muted });
    return true;
  });
}

module.exports = {
  registerRoutes,
  isBlocked,
  assertInteractionAllowed,
  blockUser,
  unblockUser,
  setMute,
  isMuted,
  mutedTargets
};