const { db, requireUser } = require('./common');

async function listClubs(userId) {
  const rows = await db.all(
    `SELECT c.*,u.username,u.name owner_name,
      COALESCE(s.status,'active') status,COALESCE(j.join_mode,'open') join_mode
     FROM clubs c JOIN users u ON u.id=c.owner_id
     LEFT JOIN club_settings s ON s.club_id=c.id
     LEFT JOIN club_join_settings j ON j.club_id=c.id
     WHERE COALESCE(s.status,'active')<>'archived' ORDER BY c.created_at DESC`
  );
  const output = [];
  for (const row of rows) {
    const [count, member, role, request, invite] = await Promise.all([
      db.get('SELECT COUNT(*) n FROM club_members WHERE club_id=?', [row.id]),
      db.get('SELECT 1 FROM club_members WHERE club_id=? AND user_id=?', [row.id, userId]),
      db.get('SELECT role FROM club_member_roles WHERE club_id=? AND user_id=?', [row.id, userId]),
      db.get("SELECT id,status,message,created_at FROM club_membership_requests WHERE club_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1", [row.id, userId]),
      db.get("SELECT id,status,created_at FROM club_invites WHERE club_id=? AND invited_user_id=? ORDER BY created_at DESC LIMIT 1", [row.id, userId])
    ]);
    output.push({
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      accent: row.accent,
      status: row.status,
      joinMode: row.join_mode,
      ownerId: row.owner_id,
      username: row.username,
      ownerName: row.owner_name,
      members: Number(count.n),
      joined: !!member,
      isOwner: row.owner_id === userId,
      memberRole: row.owner_id === userId ? 'Owner' : (role?.role || (member ? 'Member' : null)),
      request: request ? { id: request.id, status: request.status, message: request.message, createdAt: request.created_at } : null,
      invite: invite ? { id: invite.id, status: invite.status, createdAt: invite.created_at } : null,
      createdAt: row.created_at
    });
  }
  return output;
}

function registerRoutes(registerRoute) {
  registerRoute('GET', '/api/clubs', async ({ req, res }) => {
    const user = await requireUser(req);
    res.json({ clubs: await listClubs(user.id) });
    return true;
  });
}

module.exports = { registerRoutes, listClubs };
