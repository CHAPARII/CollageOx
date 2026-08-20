const { db, requireUser, httpError } = require('./common');
const { visiblePost, serializePost } = require('./social');

function registerRoutes(registerRoute) {
  registerRoute('GET', /^\/api\/pins\/(project|club)\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const contextType = match[1];
    const contextId = decodeURIComponent(match[2]);
    const exists = contextType === 'project'
      ? await db.get('SELECT id FROM projects WHERE id=?', [contextId])
      : await db.get('SELECT id FROM clubs WHERE id=?', [contextId]);
    if (!exists) throw httpError(404, `${contextType === 'project' ? 'Project' : 'Club'} not found.`);
    const pin = await db.get(
      'SELECT post_id,created_at FROM pinned_posts WHERE context_type=? AND context_id=?',
      [contextType, contextId]
    );
    if (!pin) return res.json({ post: null });
    const row = await visiblePost(pin.post_id, user.id);
    if (!row) return res.json({ post: null });
    res.json({ post: await serializePost(row, user.id), pinnedAt: pin.created_at });
    return true;
  });
}

module.exports = { registerRoutes };
