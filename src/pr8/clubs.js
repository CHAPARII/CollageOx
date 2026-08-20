const { db, now, id, clean, readBody, requireUser, httpError } = require('./common');
const { notify, emitNotificationCount } = require('./notifications');
const { emit } = require('./event-hub');

const CLUB_ROLES = new Set(['Owner', 'Admin', 'Moderator', 'Member']);
const JOIN_MODES = new Set(['open', 'approval', 'invite']);

async function clubRow(clubId) {
  return await db.get(
    `SELECT c.*,COALESCE(s.status,'active') status,COALESCE(j.join_mode,'open') join_mode
     FROM clubs c LEFT JOIN club_settings s ON s.club_id=c.id LEFT JOIN club_join_settings j ON j.club_id=c.id
     WHERE c.id=?`,
    [clubId]
  );
}

async function clubRole(clubId, userId) {
  const club = await db.get('SELECT owner_id FROM clubs WHERE id=?', [clubId]);
  if (!club) return null;
  if (club.owner_id === userId) return 'Owner';
  const row = await db.get('SELECT role FROM club_member_roles WHERE club_id=? AND user_id=?', [clubId, userId]);
  if (row) return row.role;
  return await db.get('SELECT 1 FROM club_members WHERE club_id=? AND user_id=?', [clubId, userId]) ? 'Member' : null;
}

async function canManageMembers(clubId, user) {
  if (['owner', 'management'].includes(user.role)) return true;
  return ['Owner', 'Admin'].includes(await clubRole(clubId, user.id));
}

async function listClubs(userId) {
  const rows = await db.all(
    `SELECT c.*,u.username,u.name,COALESCE(s.status,'active') status,COALESCE(j.join_mode,'open') join_mode
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
      ownerName: row.name,
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

async function addMember(tx, clubId, userId, role = 'Member') {
  await tx.run(
    `INSERT INTO club_members (club_id,user_id,joined_at) VALUES (?,?,?)
     ON CONFLICT(club_id,user_id) DO NOTHING`,
    [clubId, userId, now()]
  );
  await tx.run(
    `INSERT INTO club_member_roles (club_id,user_id,role,updated_at) VALUES (?,?,?,?)
     ON CONFLICT(club_id,user_id) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at`,
    [clubId, userId, role, now()]
  );
}

async function requestJoin(user, clubId, message = '') {
  const club = await clubRow(clubId);
  if (!club) throw httpError(404, 'Club not found.');
  if (club.status !== 'active') throw httpError(409, 'This club is not accepting members.');
  if (await db.get('SELECT 1 FROM club_members WHERE club_id=? AND user_id=?', [club.id, user.id])) return { joined: true, status: 'member' };
  if (club.join_mode === 'open') {
    await db.transaction(tx => addMember(tx, club.id, user.id));
    await notify({ userId: club.owner_id, actorId: user.id, kind: 'club_join', entityId: club.id, text: `${user.name} joined ${club.name}.`, category: 'clubs' });
    emit('club', { id: club.id, membershipChanged: true });
    return { joined: true, status: 'member' };
  }
  if (club.join_mode === 'invite') {
    const invite = await db.get("SELECT * FROM club_invites WHERE club_id=? AND invited_user_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1", [club.id, user.id]);
    if (!invite) throw httpError(403, 'This club is invite only.');
    await db.transaction(async tx => {
      await addMember(tx, club.id, user.id);
      await tx.run("UPDATE club_invites SET status='accepted',updated_at=? WHERE id=?", [now(), invite.id]);
    });
    emit('club', { id: club.id, membershipChanged: true });
    return { joined: true, status: 'member' };
  }
  const body = clean(message, 300);
  if (!body) throw httpError(400, 'Add a short message with your join request.');
  const existing = await db.get("SELECT id FROM club_membership_requests WHERE club_id=? AND user_id=? AND status='pending'", [club.id, user.id]);
  if (existing) throw httpError(409, 'Your join request is already pending.');
  const requestId = id('creq');
  const timestamp = now();
  await db.run(
    `INSERT INTO club_membership_requests (id,club_id,user_id,message,status,reviewed_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [requestId, club.id, user.id, body, 'pending', null, timestamp, timestamp]
  );
  await notify({ userId: club.owner_id, actorId: user.id, kind: 'club_request', entityId: club.id, text: `${user.name} requested to join ${club.name}.`, category: 'clubs' });
  emitNotificationCount([club.owner_id]);
  emit('club_request', { clubId: club.id, requestId }, [club.owner_id]);
  return { joined: false, status: 'pending', requestId };
}

async function reviewRequest(user, clubId, requestId, decision) {
  if (!['accepted', 'rejected'].includes(decision)) throw httpError(400, 'Choose accepted or rejected.');
  if (!(await canManageMembers(clubId, user))) throw httpError(403, 'Club owner or admin access required.');
  let applicant = null;
  let club = null;
  await db.transaction(async tx => {
    club = await tx.get('SELECT * FROM clubs WHERE id=?', [clubId]);
    if (!club) throw httpError(404, 'Club not found.');
    const request = await tx.get('SELECT * FROM club_membership_requests WHERE id=? AND club_id=?', [requestId, clubId]);
    if (!request) throw httpError(404, 'Join request not found.');
    if (request.status !== 'pending') throw httpError(409, 'This request has already been reviewed.');
    applicant = request.user_id;
    if (decision === 'accepted') await addMember(tx, clubId, request.user_id);
    await tx.run('UPDATE club_membership_requests SET status=?,reviewed_by=?,updated_at=? WHERE id=?', [decision, user.id, now(), requestId]);
  });
  await notify({
    userId: applicant,
    actorId: user.id,
    kind: decision === 'accepted' ? 'club_request_accepted' : 'club_request_rejected',
    entityId: clubId,
    text: decision === 'accepted' ? `Your request to join ${club.name} was accepted.` : `Your request to join ${club.name} was not accepted.`,
    category: 'clubs'
  });
  emitNotificationCount([applicant]);
  emit('club', { id: clubId, membershipChanged: decision === 'accepted' });
  return decision;
}

function registerRoutes(registerRoute) {
  registerRoute('GET', '/api/clubs', async ({ req, res }) => {
    const user = await requireUser(req);
    res.json({ clubs: await listClubs(user.id) });
    return true;
  });

  registerRoute('PATCH', /^\/api\/clubs\/([^/]+)\/join-settings$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const clubId = decodeURIComponent(match[1]);
    const club = await clubRow(clubId);
    if (!club) throw httpError(404, 'Club not found.');
    if (club.owner_id !== user.id && user.role !== 'owner') throw httpError(403, 'Only the club owner can change join settings.');
    const input = await readBody(req);
    const mode = JOIN_MODES.has(input.mode) ? input.mode : null;
    if (!mode) throw httpError(400, 'Choose open, approval, or invite.');
    await db.run(
      `INSERT INTO club_join_settings (club_id,join_mode,updated_at) VALUES (?,?,?)
       ON CONFLICT(club_id) DO UPDATE SET join_mode=excluded.join_mode,updated_at=excluded.updated_at`,
      [clubId, mode, now()]
    );
    emit('club', { id: clubId, joinMode: mode });
    res.json({ joinMode: mode });
    return true;
  });

  registerRoute('POST', /^\/api\/clubs\/([^/]+)\/join$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const clubId = decodeURIComponent(match[1]);
    const club = await clubRow(clubId);
    if (!club) throw httpError(404, 'Club not found.');
    const existing = await db.get('SELECT 1 FROM club_members WHERE club_id=? AND user_id=?', [clubId, user.id]);
    if (existing) {
      if (club.owner_id === user.id) throw httpError(409, 'The club owner cannot leave their own club.');
      await db.transaction(async tx => {
        await tx.run('DELETE FROM club_member_roles WHERE club_id=? AND user_id=?', [clubId, user.id]);
        await tx.run('DELETE FROM club_members WHERE club_id=? AND user_id=?', [clubId, user.id]);
      });
      emit('club', { id: clubId, membershipChanged: true });
      return res.json({ joined: false, status: 'left' });
    }
    const input = await readBody(req);
    const result = await requestJoin(user, clubId, input.message);
    res.json(result, result.status === 'pending' ? 202 : 200);
    return true;
  });

  registerRoute('GET', /^\/api\/clubs\/([^/]+)\/requests$/, async ({ req, res, url, match }) => {
    const user = await requireUser(req);
    const clubId = decodeURIComponent(match[1]);
    if (!(await canManageMembers(clubId, user))) throw httpError(403, 'Club owner or admin access required.');
    const status = ['pending', 'accepted', 'rejected', 'cancelled'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'pending';
    const rows = await db.all(
      `SELECT r.*,u.username,u.name,u.role,u.avatar,u.accent,u.department
       FROM club_membership_requests r JOIN users u ON u.id=r.user_id
       WHERE r.club_id=? AND r.status=? ORDER BY r.created_at ASC`,
      [clubId, status]
    );
    res.json({ requests: rows.map(row => ({
      id: row.id, message: row.message, status: row.status, createdAt: row.created_at,
      user: { id: row.user_id, username: row.username, name: row.name, role: row.role, avatar: row.avatar || '', accent: row.accent || '#155eef', department: row.department || '' }
    })) });
    return true;
  });

  registerRoute('PATCH', /^\/api\/clubs\/([^/]+)\/requests\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const input = await readBody(req);
    const status = await reviewRequest(user, decodeURIComponent(match[1]), decodeURIComponent(match[2]), input.status);
    res.json({ status });
    return true;
  });

  registerRoute('POST', /^\/api\/clubs\/([^/]+)\/invites$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const clubId = decodeURIComponent(match[1]);
    if (!(await canManageMembers(clubId, user))) throw httpError(403, 'Club owner or admin access required.');
    const input = await readBody(req);
    const target = await db.get('SELECT id,username,name FROM users WHERE LOWER(username)=LOWER(?)', [clean(input.username, 24)]);
    if (!target) throw httpError(404, 'User not found.');
    if (await db.get('SELECT 1 FROM club_members WHERE club_id=? AND user_id=?', [clubId, target.id])) throw httpError(409, 'This user is already a member.');
    const pending = await db.get("SELECT id FROM club_invites WHERE club_id=? AND invited_user_id=? AND status='pending'", [clubId, target.id]);
    if (pending) throw httpError(409, 'This user already has a pending invite.');
    const inviteId = id('cinvite');
    const timestamp = now();
    await db.run(
      'INSERT INTO club_invites (id,club_id,invited_user_id,invited_by,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      [inviteId, clubId, target.id, user.id, 'pending', timestamp, timestamp]
    );
    const club = await clubRow(clubId);
    await notify({ userId: target.id, actorId: user.id, kind: 'club_invite', entityId: clubId, text: `You were invited to ${club.name}.`, category: 'clubs' });
    emitNotificationCount([target.id]);
    emit('club_invite', { clubId, inviteId }, [target.id]);
    res.json({ invite: { id: inviteId, user: target, status: 'pending' } }, 201);
    return true;
  });

  registerRoute('GET', /^\/api\/clubs\/([^/]+)\/members$/, async ({ req, res, match }) => {
    await requireUser(req);
    const clubId = decodeURIComponent(match[1]);
    const club = await clubRow(clubId);
    if (!club) throw httpError(404, 'Club not found.');
    const rows = await db.all(
      `SELECT u.id,u.username,u.name,u.role,u.avatar,u.accent,u.department,m.joined_at,r.role club_role
       FROM club_members m JOIN users u ON u.id=m.user_id
       LEFT JOIN club_member_roles r ON r.club_id=m.club_id AND r.user_id=m.user_id
       WHERE m.club_id=? ORDER BY m.joined_at ASC`,
      [clubId]
    );
    res.json({ members: rows.map(row => ({
      id: row.id, username: row.username, name: row.name, role: row.role, avatar: row.avatar || '', accent: row.accent || '#155eef', department: row.department || '',
      clubRole: row.id === club.owner_id ? 'Owner' : (row.club_role || 'Member'), joinedAt: row.joined_at
    })) });
    return true;
  });

  registerRoute('PATCH', /^\/api\/clubs\/([^/]+)\/members\/([^/]+)\/role$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const clubId = decodeURIComponent(match[1]);
    const targetId = decodeURIComponent(match[2]);
    const club = await clubRow(clubId);
    if (!club) throw httpError(404, 'Club not found.');
    if (club.owner_id !== user.id && user.role !== 'owner') throw httpError(403, 'Only the club owner can assign roles.');
    if (targetId === club.owner_id) throw httpError(409, 'The club owner is always Owner.');
    const member = await db.get('SELECT 1 FROM club_members WHERE club_id=? AND user_id=?', [clubId, targetId]);
    if (!member) throw httpError(404, 'Club member not found.');
    const input = await readBody(req);
    const role = CLUB_ROLES.has(input.role) && input.role !== 'Owner' ? input.role : null;
    if (!role) throw httpError(400, 'Choose Admin, Moderator, or Member.');
    await db.run(
      `INSERT INTO club_member_roles (club_id,user_id,role,updated_at) VALUES (?,?,?,?)
       ON CONFLICT(club_id,user_id) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at`,
      [clubId, targetId, role, now()]
    );
    emit('club', { id: clubId, rolesChanged: true });
    res.json({ role });
    return true;
  });

  registerRoute('POST', /^\/api\/clubs\/([^/]+)\/events$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const clubId = decodeURIComponent(match[1]);
    if (!(await canManageMembers(clubId, user))) throw httpError(403, 'Club owner or admin access required.');
    const club = await clubRow(clubId);
    if (!club) throw httpError(404, 'Club not found.');
    const input = await readBody(req);
    const title = clean(input.title, 100);
    const starts = new Date(input.startsAt);
    if (!title) throw httpError(400, 'Add an event title.');
    if (Number.isNaN(starts.getTime()) || starts.getTime() <= Date.now()) throw httpError(400, 'Choose a future event date.');
    const capacity = Math.min(5000, Math.max(2, Math.floor(Number(input.capacity) || 100)));
    const eventId = id('event');
    const timestamp = now();
    await db.transaction(async tx => {
      await tx.run(
        'INSERT INTO events (id,creator_id,title,description,starts_at,location,capacity,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [eventId, user.id, title, clean(input.description, 800), starts.toISOString(), clean(input.location, 120), capacity, timestamp]
      );
      await tx.run('INSERT INTO event_attendees (event_id,user_id,joined_at) VALUES (?,?,?)', [eventId, user.id, timestamp]);
      await tx.run('INSERT INTO event_contexts (event_id,context_type,context_id,created_at) VALUES (?,?,?,?)', [eventId, 'club', clubId, timestamp]);
    });
    emit('event', { id: eventId, clubId });
    res.json({ event: { id: eventId, title, startsAt: starts.toISOString(), capacity, clubId } }, 201);
    return true;
  });

  registerRoute('GET', /^\/api\/clubs\/([^/]+)\/events$/, async ({ req, res, match }) => {
    await requireUser(req);
    const clubId = decodeURIComponent(match[1]);
    const rows = await db.all(
      `SELECT e.* FROM event_contexts c JOIN events e ON e.id=c.event_id
       WHERE c.context_type='club' AND c.context_id=? AND e.starts_at>? ORDER BY e.starts_at ASC`,
      [clubId, now()]
    );
    res.json({ events: rows.map(row => ({ id: row.id, title: row.title, description: row.description, startsAt: row.starts_at, location: row.location, capacity: Number(row.capacity) })) });
    return true;
  });

  registerRoute('POST', /^\/api\/clubs\/([^/]+)\/transfer$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const clubId = decodeURIComponent(match[1]);
    const club = await clubRow(clubId);
    if (!club) throw httpError(404, 'Club not found.');
    if (club.owner_id !== user.id && !['owner', 'management'].includes(user.role)) throw httpError(403, 'Only the club owner or management can transfer ownership.');
    const input = await readBody(req);
    const target = await db.get('SELECT id,username,name FROM users WHERE LOWER(username)=LOWER(?)', [clean(input.username, 24)]);
    if (!target) throw httpError(404, 'New owner not found.');
    if (!(await db.get('SELECT 1 FROM club_members WHERE club_id=? AND user_id=?', [clubId, target.id]))) throw httpError(409, 'The new owner must already be a club member.');
    await db.transaction(async tx => {
      await tx.run('UPDATE clubs SET owner_id=? WHERE id=?', [target.id, clubId]);
      await tx.run(
        `INSERT INTO club_member_roles (club_id,user_id,role,updated_at) VALUES (?,?,?,?)
         ON CONFLICT(club_id,user_id) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at`,
        [clubId, target.id, 'Owner', now()]
      );
      if (club.owner_id !== target.id) {
        await tx.run(
          `INSERT INTO club_member_roles (club_id,user_id,role,updated_at) VALUES (?,?,?,?)
           ON CONFLICT(club_id,user_id) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at`,
          [clubId, club.owner_id, 'Member', now()]
        );
      }
    });
    await notify({ userId: target.id, actorId: user.id, kind: 'club_owner', entityId: clubId, text: `You are now the owner of ${club.name}.`, category: 'clubs' });
    emit('club', { id: clubId, ownershipChanged: true });
    res.json({ ok: true, owner: target });
    return true;
  });
}

module.exports = {
  registerRoutes,
  listClubs,
  clubRow,
  clubRole,
  canManageMembers,
  requestJoin,
  reviewRequest,
  CLUB_ROLES,
  JOIN_MODES
};
