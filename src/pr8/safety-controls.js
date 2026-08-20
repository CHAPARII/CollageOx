const { db, clean, requireUser, httpError } = require('./common');

function registerRoutes(registerRoute) {
  registerRoute('GET', '/api/safety/mutes', async ({ req, res, url }) => {
    const user = await requireUser(req);
    const targetType = clean(url.searchParams.get('targetType') || 'user', 30).toLowerCase();
    if (!['user', 'club'].includes(targetType)) throw httpError(400, 'Only user or club mutes can be listed here.');

    if (targetType === 'club') {
      const rows = await db.all(
        `SELECT m.target_id,c.name,c.category,c.accent,m.created_at
         FROM user_mutes m JOIN clubs c ON c.id=m.target_id
         WHERE m.user_id=? AND m.target_type='club'
         ORDER BY m.created_at DESC`,
        [user.id]
      );
      res.json({
        mutes: rows.map(row => ({
          id: row.target_id,
          name: row.name,
          category: row.category || '',
          accent: row.accent || '#155eef',
          createdAt: row.created_at
        }))
      });
      return true;
    }

    const rows = await db.all(
      `SELECT m.target_id,u.username,u.name,u.role,u.avatar,u.accent,m.created_at
       FROM user_mutes m JOIN users u ON u.id=m.target_id
       WHERE m.user_id=? AND m.target_type='user'
       ORDER BY m.created_at DESC`,
      [user.id]
    );
    res.json({
      mutes: rows.map(row => ({
        id: row.target_id,
        username: row.username,
        name: row.name,
        role: row.role,
        avatar: row.avatar || '',
        accent: row.accent || '#155eef',
        createdAt: row.created_at
      }))
    });
    return true;
  });
}

module.exports = { registerRoutes };
