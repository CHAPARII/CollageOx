const {
  db,
  now,
  id,
  clean,
  readBody,
  requireUser,
  httpError,
  pageLimit,
  encodeCursor,
  decodeCursor,
  publicUser,
  bool
} = require('./common');
const { emit } = require('./event-hub');
const { assertInteractionAllowed, isMuted } = require('./safety');
const { presenceFor, touchPresence } = require('./presence');

function canonicalPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

async function conversationRow(conversationId, userId) {
  const row = await db.get(
    `SELECT * FROM dm_conversations
     WHERE id=? AND (user_low_id=? OR user_high_id=?)`,
    [conversationId, userId, userId]
  );
  return row || null;
}

function otherUserId(conversation, userId) {
  return conversation.user_low_id === userId ? conversation.user_high_id : conversation.user_low_id;
}

async function getOrCreateConversation(userId, targetUserId) {
  if (!targetUserId || userId === targetUserId) throw httpError(400, 'Choose another person to message.');
  const target = await db.get('SELECT * FROM users WHERE id=?', [targetUserId]);
  if (!target) throw httpError(404, 'User not found.');
  await assertInteractionAllowed(userId, targetUserId);
  const [low, high] = canonicalPair(userId, targetUserId);
  let conversation = await db.get(
    'SELECT * FROM dm_conversations WHERE user_low_id=? AND user_high_id=?',
    [low, high]
  );
  if (!conversation) {
    const createdAt = now();
    const conversationId = id('dm');
    await db.run(
      `INSERT INTO dm_conversations (id,user_low_id,user_high_id,created_at,last_message_at)
       VALUES (?,?,?,?,?) ON CONFLICT(user_low_id,user_high_id) DO NOTHING`,
      [conversationId, low, high, createdAt, createdAt]
    );
    conversation = await db.get(
      'SELECT * FROM dm_conversations WHERE user_low_id=? AND user_high_id=?',
      [low, high]
    );
  }
  return { conversation, target };
}

async function serializeConversation(row, userId) {
  const otherId = otherUserId(row, userId);
  const other = await db.get('SELECT * FROM users WHERE id=?', [otherId]);
  if (!other) return null;
  const latest = await db.get(
    `SELECT id,sender_id,body,seen_at,created_at FROM dm_messages
     WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 1`,
    [row.id]
  );
  const unread = await db.get(
    `SELECT COUNT(*) n FROM dm_messages
     WHERE conversation_id=? AND sender_id<>? AND seen_at IS NULL`,
    [row.id, userId]
  );
  const setting = await db.get(
    'SELECT muted FROM dm_settings WHERE conversation_id=? AND user_id=?',
    [row.id, userId]
  );
  const presence = (await presenceFor([otherId])).get(otherId) || { online: false, lastSeenAt: null };
  return {
    id: row.id,
    other: publicUser(other),
    latestMessage: latest ? {
      id: latest.id,
      senderId: latest.sender_id,
      body: latest.body,
      seenAt: latest.seen_at,
      createdAt: latest.created_at
    } : null,
    unread: Number(unread?.n || 0),
    muted: !!setting?.muted,
    presence,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at
  };
}

async function listConversations(userId, limit = 40) {
  const rows = await db.all(
    `SELECT * FROM dm_conversations
     WHERE user_low_id=? OR user_high_id=?
     ORDER BY last_message_at DESC,id DESC LIMIT ${pageLimit(limit, 40, 80)}`,
    [userId, userId]
  );
  const output = [];
  for (const row of rows) {
    const item = await serializeConversation(row, userId);
    if (item) output.push(item);
  }
  return output;
}

function serializeMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    body: row.body,
    seenAt: row.seen_at,
    createdAt: row.created_at
  };
}

async function listMessages(conversation, userId, cursor, limit) {
  const decoded = decodeCursor(cursor);
  const params = [conversation.id];
  let cursorWhere = '';
  if (decoded) {
    cursorWhere = 'AND (created_at<? OR (created_at=? AND id<?))';
    params.push(decoded.createdAt, decoded.createdAt, decoded.id);
  }
  const take = pageLimit(limit, 40, 80);
  const rows = await db.all(
    `SELECT id,conversation_id,sender_id,body,seen_at,created_at
     FROM dm_messages WHERE conversation_id=? ${cursorWhere}
     ORDER BY created_at DESC,id DESC LIMIT ${take + 1}`,
    params
  );
  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  return {
    messages: page.reverse().map(serializeMessage),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null
  };
}

async function insertNotification(tx, recipientId, sender, conversationId, body) {
  const muted = await isMuted(recipientId, 'dm', conversationId);
  const setting = await tx.get('SELECT muted FROM dm_settings WHERE conversation_id=? AND user_id=?', [conversationId, recipientId]);
  if (muted || setting?.muted) return false;
  await tx.run(
    `INSERT INTO notifications (id,user_id,actor_id,kind,entity_id,text,created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [id('note'), recipientId, sender.id, 'dm_message', conversationId, `${sender.name}: ${clean(body, 120)}`, now()]
  );
  return true;
}

function registerRoutes(registerRoute) {
  registerRoute('GET', '/api/dm/conversations', async ({ req, res, url }) => {
    const user = await requireUser(req);
    await touchPresence(user.id);
    res.json({ conversations: await listConversations(user.id, url.searchParams.get('limit')) });
    return true;
  });

  registerRoute('POST', '/api/dm/conversations', async ({ req, res }) => {
    const user = await requireUser(req);
    const input = await readBody(req);
    let target = null;
    if (input.userId) target = await db.get('SELECT * FROM users WHERE id=?', [clean(input.userId, 120)]);
    else if (input.username) target = await db.get('SELECT * FROM users WHERE LOWER(username)=LOWER(?)', [clean(input.username, 24)]);
    if (!target) throw httpError(404, 'User not found.');
    const { conversation } = await getOrCreateConversation(user.id, target.id);
    await touchPresence(user.id);
    res.json({ conversation: await serializeConversation(conversation, user.id) }, 201);
    return true;
  });

  registerRoute('GET', /^\/api\/dm\/([^/]+)\/messages$/, async ({ req, res, url, match }) => {
    const user = await requireUser(req);
    const conversation = await conversationRow(decodeURIComponent(match[1]), user.id);
    if (!conversation) throw httpError(404, 'Conversation not found.');
    const otherId = otherUserId(conversation, user.id);
    await assertInteractionAllowed(user.id, otherId);
    await touchPresence(user.id);
    const result = await listMessages(conversation, user.id, url.searchParams.get('cursor'), url.searchParams.get('limit'));
    const other = await db.get('SELECT * FROM users WHERE id=?', [otherId]);
    const presence = (await presenceFor([otherId])).get(otherId) || { online: false, lastSeenAt: null };
    res.json({ conversation: { id: conversation.id, other: publicUser(other), presence }, ...result });
    return true;
  });

  registerRoute('POST', /^\/api\/dm\/([^/]+)\/messages$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const conversation = await conversationRow(decodeURIComponent(match[1]), user.id);
    if (!conversation) throw httpError(404, 'Conversation not found.');
    const recipientId = otherUserId(conversation, user.id);
    await assertInteractionAllowed(user.id, recipientId);
    const input = await readBody(req, 12000);
    const body = clean(input.body, 2000);
    if (!body) throw httpError(400, 'Message cannot be empty.');
    const createdAt = now();
    const message = {
      id: id('dmsg'),
      conversation_id: conversation.id,
      sender_id: user.id,
      body,
      seen_at: null,
      created_at: createdAt
    };
    let notificationCreated = false;
    await db.transaction(async tx => {
      await tx.run(
        `INSERT INTO dm_messages (id,conversation_id,sender_id,body,seen_at,created_at)
         VALUES (?,?,?,?,?,?)`,
        [message.id, conversation.id, user.id, body, null, createdAt]
      );
      await tx.run('UPDATE dm_conversations SET last_message_at=? WHERE id=?', [createdAt, conversation.id]);
      notificationCreated = await insertNotification(tx, recipientId, user, conversation.id, body);
    });
    await touchPresence(user.id);
    const payload = serializeMessage(message);
    emit('dm_message', { message: payload, conversationId: conversation.id }, [user.id, recipientId]);
    if (notificationCreated) emit('notification_count', { changed: true }, [recipientId]);
    res.json({ message: payload }, 201);
    return true;
  });

  registerRoute('POST', /^\/api\/dm\/([^/]+)\/seen$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const conversation = await conversationRow(decodeURIComponent(match[1]), user.id);
    if (!conversation) throw httpError(404, 'Conversation not found.');
    const senderId = otherUserId(conversation, user.id);
    await assertInteractionAllowed(user.id, senderId);
    const timestamp = now();
    await db.run(
      `UPDATE dm_messages SET seen_at=?
       WHERE conversation_id=? AND sender_id<>? AND seen_at IS NULL`,
      [timestamp, conversation.id, user.id]
    );
    await touchPresence(user.id);
    emit('dm_seen', { conversationId: conversation.id, seenBy: user.id, seenAt: timestamp }, [senderId]);
    res.json({ ok: true, seenAt: timestamp });
    return true;
  });

  registerRoute('PATCH', /^\/api\/dm\/([^/]+)\/settings$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const conversation = await conversationRow(decodeURIComponent(match[1]), user.id);
    if (!conversation) throw httpError(404, 'Conversation not found.');
    const input = await readBody(req);
    const muted = bool(input.muted);
    await db.run(
      `INSERT INTO dm_settings (conversation_id,user_id,muted,updated_at) VALUES (?,?,?,?)
       ON CONFLICT(conversation_id,user_id) DO UPDATE SET muted=excluded.muted,updated_at=excluded.updated_at`,
      [conversation.id, user.id, muted ? 1 : 0, now()]
    );
    res.json({ muted });
    return true;
  });

  registerRoute('POST', '/api/dm/typing', async ({ req, res }) => {
    const user = await requireUser(req);
    const input = await readBody(req, 4000);
    const conversation = await conversationRow(clean(input.conversationId, 120), user.id);
    if (!conversation) throw httpError(404, 'Conversation not found.');
    const recipientId = otherUserId(conversation, user.id);
    await assertInteractionAllowed(user.id, recipientId);
    await touchPresence(user.id);
    emit('dm_typing', {
      conversationId: conversation.id,
      userId: user.id,
      active: bool(input.active)
    }, [recipientId]);
    res.json({ ok: true });
    return true;
  });
}

module.exports = {
  registerRoutes,
  canonicalPair,
  getOrCreateConversation,
  conversationRow,
  otherUserId,
  listConversations,
  listMessages
};