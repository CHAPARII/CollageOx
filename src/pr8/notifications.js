const { db, id, now, clean, pageLimit, readBody, requireUser } = require('./common');
const { emit } = require('./event-hub');

const PUSH_CATEGORIES = new Set(['dm', 'mentions', 'projects', 'clubs', 'events', 'announcements']);

async function categoryEnabled(userId, category, queryDb = db) {
  const row = await queryDb.get(
    'SELECT enabled FROM notification_preferences WHERE user_id=? AND category=?',
    [userId, clean(category, 40)]
  );
  return row ? !!row.enabled : true;
}

function schedulePush(notificationId, userId, kind, entityId, text, category) {
  if (!PUSH_CATEGORIES.has(category)) return;
  const { vapidConfig } = require('./push');
  if (!vapidConfig().enabled) return;
  setTimeout(async () => {
    try {
      const stored = await db.get('SELECT id FROM notifications WHERE id=? AND user_id=?', [notificationId, userId]);
      if (!stored) return;
      const { deliverPush } = require('./push');
      await deliverPush(userId, {
        title: 'College Ox',
        body: clean(text, 180),
        kind: clean(kind, 60),
        entityId: clean(entityId, 160)
      });
    } catch (error) {
      console.error(`Push notification failed: ${error.message}`);
    }
  }, 0);
}

async function notify({ userId, actorId = null, kind, entityId = '', text, category = 'social', dedupeKey = null, tx = db }) {
  if (!userId || (actorId && userId === actorId)) return null;
  if (!(await categoryEnabled(userId, category, tx))) return null;
  const normalizedKind = clean(kind, 60);
  const normalizedEntityId = clean(entityId, 160);
  const normalizedText = clean(text, 240);
  if (dedupeKey) {
    const existing = await tx.get(
      `SELECT id FROM notifications
       WHERE user_id=? AND kind=? AND entity_id=? AND read_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [userId, normalizedKind, normalizedEntityId]
    );
    if (existing) return existing.id;
  }
  const notificationId = id('note');
  await tx.run(
    `INSERT INTO notifications (id,user_id,actor_id,kind,entity_id,text,created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [notificationId, userId, actorId || null, normalizedKind, normalizedEntityId, normalizedText, now()]
  );
  if (tx === db) emit('notification_count', { changed: true }, [userId]);
  schedulePush(notificationId, userId, normalizedKind, normalizedEntityId, normalizedText, category);
  return notificationId;
}

function emitNotificationCount(userIds) {
  emit('notification_count', { changed: true }, userIds);
}

function registerRoutes(registerRoute) {
  registerRoute('GET', '/api/notifications', async ({ req, res, url }) => {
    const user = await requireUser(req);
    const limit = pageLimit(url.searchParams.get('limit'), 40, 100);
    const rows = await db.all(
      `SELECT n.*,u.username actor_username,u.name actor_name
       FROM notifications n LEFT JOIN users u ON u.id=n.actor_id
       WHERE n.user_id=? ORDER BY n.created_at DESC LIMIT ${limit}`,
      [user.id]
    );
    const unread = await db.get('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL', [user.id]);
    res.json({ notifications: rows, unread: Number(unread?.n || 0) });
    return true;
  });

  registerRoute('POST', '/api/notifications', async ({ req, res }) => {
    const user = await requireUser(req);
    const input = await readBody(req);
    if (input.all) {
      await db.run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', [now(), user.id]);
    } else if (input.id) {
      await db.run('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?', [now(), clean(input.id, 80), user.id]);
    }
    res.json({ ok: true });
    return true;
  });
}

module.exports = { notify, categoryEnabled, emitNotificationCount, schedulePush, PUSH_CATEGORIES, registerRoutes };