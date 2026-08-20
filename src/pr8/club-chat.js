const { db, now, id, clean, readBody, requireUser, httpError, publicUser } = require('./common');
const { clubRow } = require('./clubs');
const { indexTextMentionsAndHashtags } = require('./social');
const { emit } = require('./event-hub');

const chatBuckets = new Map();

function allowChat(userId, maximum = 30, windowMs = 60000) {
  const time = Date.now();
  let bucket = chatBuckets.get(userId);
  if (!bucket || bucket.resetAt <= time) bucket = { count: 0, resetAt: time + windowMs };
  bucket.count += 1;
  chatBuckets.set(userId, bucket);
  return bucket.count <= maximum;
}

async function requireClubMember(clubId, userId) {
  const club = await clubRow(clubId);
  if (!club) throw httpError(404, 'Club not found.');
  const member = await db.get('SELECT 1 FROM club_members WHERE club_id=? AND user_id=?', [clubId, userId]);
  if (!member) throw httpError(403, 'Join this club to open its chat.');
  return club;
}

async function clubMessages(clubId) {
  const rows = await db.all(
    `SELECT m.id,m.club_id,m.author_id,m.body,m.created_at,
      u.username,u.name,u.role,u.avatar,u.accent,u.department,u.profile_visibility
     FROM club_messages m JOIN users u ON u.id=m.author_id
     WHERE m.club_id=? ORDER BY m.created_at ASC LIMIT 300`,
    [clubId]
  );
  return rows.map(row => ({
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    author: publicUser({ ...row, id: row.author_id })
  }));
}

async function memberIds(clubId) {
  return (await db.all('SELECT user_id FROM club_members WHERE club_id=?', [clubId])).map(row => row.user_id);
}

function registerRoutes(registerRoute) {
  registerRoute('GET', /^\/api\/clubs\/([^/]+)\/messages$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const clubId = decodeURIComponent(match[1]);
    const club = await requireClubMember(clubId, user.id);
    res.json({
      club: { id: club.id, name: club.name, accent: club.accent, status: club.status },
      messages: await clubMessages(clubId)
    });
    return true;
  });

  registerRoute('POST', /^\/api\/clubs\/([^/]+)\/messages$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const clubId = decodeURIComponent(match[1]);
    const club = await requireClubMember(clubId, user.id);
    if (club.status !== 'active') throw httpError(409, 'This club is closed for new messages.');
    if (!allowChat(user.id)) throw httpError(429, 'You are sending messages too quickly.');
    const input = await readBody(req, 12000);
    const body = clean(input.body, 1000);
    if (!body) throw httpError(400, 'Write a message first.');
    const messageId = id('cmsg');
    const createdAt = now();
    await db.run(
      'INSERT INTO club_messages (id,club_id,author_id,body,created_at) VALUES (?,?,?,?,?)',
      [messageId, clubId, user.id, body, createdAt]
    );
    await indexTextMentionsAndHashtags({
      sourceType: 'club_message',
      sourceId: messageId,
      authorId: user.id,
      text: body
    });
    const message = {
      id: messageId,
      body,
      createdAt,
      author: publicUser(user)
    };
    emit('clubMessage', { clubId, messageId, message }, await memberIds(clubId));
    res.json({ message }, 201);
    return true;
  });
}

module.exports = { registerRoutes, clubMessages, requireClubMember, allowChat };
