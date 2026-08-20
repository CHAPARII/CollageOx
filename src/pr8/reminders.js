const { db, now, clean, readBody, requireUser, httpError } = require('./common');
const { notify, emitNotificationCount } = require('./notifications');
const { emit } = require('./event-hub');

const REMINDER_PRESETS = new Set([60, 1440, 10080]);

async function processDueReminders(userId = null, nowMs = Date.now()) {
  const timestamp = new Date(nowMs).toISOString();
  const params = [timestamp];
  let userFilter = '';
  if (userId) {
    userFilter = 'AND r.user_id=?';
    params.push(userId);
  }
  const rows = await db.all(
    `SELECT r.*,e.title,e.starts_at FROM event_reminders r JOIN events e ON e.id=r.event_id
     WHERE r.sent_at IS NULL AND r.due_at<=? ${userFilter}
     ORDER BY r.due_at ASC LIMIT 100`,
    params
  );
  const notified = [];
  for (const row of rows) {
    let notificationId = null;
    await db.transaction(async tx => {
      const fresh = await tx.get('SELECT * FROM event_reminders WHERE event_id=? AND user_id=?', [row.event_id, row.user_id]);
      if (!fresh || fresh.sent_at) return;
      if (new Date(row.starts_at).getTime() > nowMs) {
        const minutes = Number(row.minutes_before);
        const timing = minutes >= 10080 ? 'in about a week' : minutes >= 1440 ? 'tomorrow' : minutes >= 60 ? 'in about an hour' : 'soon';
        notificationId = await notify({
          userId: row.user_id,
          actorId: null,
          kind: 'event_reminder',
          entityId: row.event_id,
          text: `${row.title} starts ${timing}.`,
          category: 'events',
          tx
        });
      }
      await tx.run('UPDATE event_reminders SET sent_at=? WHERE event_id=? AND user_id=?', [timestamp, row.event_id, row.user_id]);
    });
    if (notificationId) notified.push(row.user_id);
  }
  if (notified.length) emitNotificationCount(notified);
  return { processed: rows.length, notified: notified.length };
}

async function calendarRows(userId, from, to) {
  const start = new Date(from || Date.now() - 7 * 86400000);
  const end = new Date(to || Date.now() + 45 * 86400000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw httpError(400, 'Choose a valid calendar range.');
  if (end.getTime() - start.getTime() > 370 * 86400000) throw httpError(400, 'Calendar range is too large.');
  const rows = await db.all(
    `SELECT e.*,u.username,u.name,
      EXISTS(SELECT 1 FROM event_attendees a WHERE a.event_id=e.id AND a.user_id=?) going,
      (SELECT COUNT(*) FROM event_attendees a WHERE a.event_id=e.id) attendees,
      c.context_type,c.context_id,
      r.minutes_before,r.sent_at
     FROM events e JOIN users u ON u.id=e.creator_id
     LEFT JOIN event_contexts c ON c.event_id=e.id
     LEFT JOIN event_reminders r ON r.event_id=e.id AND r.user_id=?
     WHERE e.starts_at>=? AND e.starts_at<? ORDER BY e.starts_at ASC`,
    [userId, userId, start.toISOString(), end.toISOString()]
  );
  return rows.map(row => ({
    id: row.id,
    title: row.title,
    description: row.description,
    startsAt: row.starts_at,
    location: row.location,
    capacity: Number(row.capacity),
    attendees: Number(row.attendees),
    going: !!row.going,
    creator: { id: row.creator_id, username: row.username, name: row.name },
    context: row.context_type ? { type: row.context_type, id: row.context_id } : null,
    reminder: row.minutes_before == null ? null : { minutesBefore: Number(row.minutes_before), sent: !!row.sent_at }
  }));
}

function registerRoutes(registerRoute) {
  registerRoute('GET', '/api/events/calendar', async ({ req, res, url }) => {
    const user = await requireUser(req);
    await processDueReminders(user.id);
    res.json({ events: await calendarRows(user.id, url.searchParams.get('from'), url.searchParams.get('to')) });
    return true;
  });

  registerRoute('PUT', /^\/api\/events\/([^/]+)\/reminder$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const eventId = decodeURIComponent(match[1]);
    const event = await db.get('SELECT * FROM events WHERE id=?', [eventId]);
    if (!event) throw httpError(404, 'Event not found.');
    if (new Date(event.starts_at).getTime() <= Date.now()) throw httpError(409, 'This event has already started.');
    if (!(await db.get('SELECT 1 FROM event_attendees WHERE event_id=? AND user_id=?', [eventId, user.id]))) throw httpError(409, 'RSVP before adding a reminder.');
    const input = await readBody(req);
    const minutes = Math.floor(Number(input.minutesBefore));
    if (!REMINDER_PRESETS.has(minutes)) throw httpError(400, 'Choose 1 hour, 1 day, or 1 week.');
    const dueAt = new Date(new Date(event.starts_at).getTime() - minutes * 60000).toISOString();
    await db.run(
      `INSERT INTO event_reminders (event_id,user_id,minutes_before,due_at,sent_at,created_at)
       VALUES (?,?,?,?,?,?) ON CONFLICT(event_id,user_id) DO UPDATE SET
       minutes_before=excluded.minutes_before,due_at=excluded.due_at,sent_at=NULL,created_at=excluded.created_at`,
      [eventId, user.id, minutes, dueAt, null, now()]
    );
    await processDueReminders(user.id);
    res.json({ reminder: { minutesBefore: minutes, dueAt } });
    return true;
  });

  registerRoute('DELETE', /^\/api\/events\/([^/]+)\/reminder$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    await db.run('DELETE FROM event_reminders WHERE event_id=? AND user_id=?', [decodeURIComponent(match[1]), user.id]);
    res.json({ ok: true });
    return true;
  });

  registerRoute('POST', '/api/reminders/process', async ({ req, res }) => {
    const user = await requireUser(req);
    res.json(await processDueReminders(user.id));
    return true;
  });
}

module.exports = { registerRoutes, processDueReminders, calendarRows, REMINDER_PRESETS };
