const { db, now, clean, requireUser } = require('./common');
const { emit, isConnected } = require('./event-hub');

const lastWrites = new Map();
const WRITE_INTERVAL_MS = 60000;
const ONLINE_WINDOW_MS = 90000;

async function touchPresence(userId, force = false) {
  const time = Date.now();
  const lastWrite = lastWrites.get(userId) || 0;
  if (!force && time - lastWrite < WRITE_INTERVAL_MS) return false;
  lastWrites.set(userId, time);
  const timestamp = new Date(time).toISOString();
  await db.run(
    `INSERT INTO user_presence (user_id,last_seen_at) VALUES (?,?)
     ON CONFLICT(user_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`,
    [userId, timestamp]
  );
  emit('presence', { userId, online: true, lastSeenAt: timestamp });
  return true;
}

async function presenceFor(userIds) {
  const unique = [...new Set((userIds || []).filter(Boolean))];
  const output = new Map();
  for (const userId of unique) {
    const row = await db.get('SELECT last_seen_at FROM user_presence WHERE user_id=?', [userId]);
    const lastSeenAt = row?.last_seen_at || null;
    const recent = lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() <= ONLINE_WINDOW_MS;
    output.set(userId, {
      online: isConnected(userId) || !!recent,
      lastSeenAt
    });
  }
  return output;
}

async function markOffline(userId) {
  const timestamp = now();
  lastWrites.set(userId, Date.now());
  await db.run(
    `INSERT INTO user_presence (user_id,last_seen_at) VALUES (?,?)
     ON CONFLICT(user_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`,
    [userId, timestamp]
  );
  emit('presence', { userId, online: false, lastSeenAt: timestamp });
}

function registerRoutes(registerRoute) {
  registerRoute('POST', '/api/presence', async ({ req, res }) => {
    const user = await requireUser(req);
    await touchPresence(user.id);
    res.json({ ok: true });
    return true;
  });

  registerRoute('GET', '/api/presence', async ({ req, res, url }) => {
    await requireUser(req);
    const ids = clean(url.searchParams.get('ids'), 4000).split(',').map(value => clean(value, 100)).filter(Boolean).slice(0, 100);
    const map = await presenceFor(ids);
    res.json({
      presence: ids.map(userId => ({ userId, ...(map.get(userId) || { online: false, lastSeenAt: null }) }))
    });
    return true;
  });
}

module.exports = {
  registerRoutes,
  touchPresence,
  presenceFor,
  markOffline,
  ONLINE_WINDOW_MS
};