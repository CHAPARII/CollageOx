const { db, now, id, clean, readBody, requireUser, httpError } = require('./common');
const { isBlocked } = require('./safety');
const { storeImage, deleteOrphanMedia } = require('./media');
const { getOrCreateConversation } = require('./dm');
const { emit } = require('./event-hub');

const STATUSES = new Set(['lost', 'found', 'returned']);

function serialize(row) {
  return {
    id: row.id,
    reporterId: row.reporter_id,
    reporter: row.username ? { id: row.reporter_id, username: row.username, name: row.name, avatar: row.avatar || '', accent: row.accent || '#155eef' } : null,
    status: row.status,
    name: row.name,
    description: row.description,
    location: row.location,
    occurredOn: row.occurred_on,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    image: row.media_id ? { id: row.media_id, src: row.media_data, mimeType: row.media_mime } : null
  };
}

async function rowWithReporter(entryId) {
  return await db.get(
    `SELECT l.*,u.username,u.name,u.avatar,u.accent,media.data media_data,media.mime_type media_mime
     FROM lost_found_entries l JOIN users u ON u.id=l.reporter_id
     LEFT JOIN media ON media.id=l.media_id WHERE l.id=?`,
    [entryId]
  );
}

async function listEntries(user, url) {
  const mine = url.searchParams.get('mine') === '1';
  const requested = clean(url.searchParams.get('status'), 20).toLowerCase();
  const status = STATUSES.has(requested) ? requested : null;
  const params = [];
  const where = [];
  if (mine) {
    where.push('l.reporter_id=?');
    params.push(user.id);
    if (status) { where.push('l.status=?'); params.push(status); }
  } else if (status) {
    where.push('l.status=?');
    params.push(status);
  } else {
    where.push("l.status IN ('lost','found')");
  }
  const rows = await db.all(
    `SELECT l.*,u.username,u.name,u.avatar,u.accent,media.data media_data,media.mime_type media_mime
     FROM lost_found_entries l JOIN users u ON u.id=l.reporter_id
     LEFT JOIN media ON media.id=l.media_id
     WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC LIMIT 160`,
    params
  );
  const output = [];
  for (const row of rows) {
    if (row.reporter_id !== user.id && await isBlocked(user.id, row.reporter_id)) continue;
    output.push(serialize(row));
  }
  return output;
}

async function createEntry(user, input) {
  const status = input.status === 'found' ? 'found' : 'lost';
  const name = clean(input.name, 100);
  const description = clean(input.description, 1000);
  const location = clean(input.location, 120);
  if (!name || !description) throw httpError(400, 'Add an item name and description.');
  const occurred = new Date(input.occurredOn || Date.now());
  if (Number.isNaN(occurred.getTime()) || occurred.getTime() > Date.now() + 86400000) throw httpError(400, 'Choose a valid date.');
  const entryId = id('lost');
  await db.transaction(async tx => {
    const media = input.image ? await storeImage(user.id, input.image, tx) : null;
    const timestamp = now();
    await tx.run(
      `INSERT INTO lost_found_entries
       (id,reporter_id,status,name,description,location,occurred_on,media_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [entryId, user.id, status, name, description, location, occurred.toISOString(), media?.id || null, timestamp, timestamp]
    );
  });
  emit('lost_found', { id: entryId, action: 'created' });
  return serialize(await rowWithReporter(entryId));
}

function registerRoutes(registerRoute) {
  registerRoute('GET', '/api/lost-found', async ({ req, res, url }) => {
    const user = await requireUser(req);
    res.json({ items: await listEntries(user, url) });
    return true;
  });

  registerRoute('POST', '/api/lost-found', async ({ req, res }) => {
    const user = await requireUser(req);
    const input = await readBody(req, 700000);
    res.json({ item: await createEntry(user, input) }, 201);
    return true;
  });

  registerRoute('GET', /^\/api\/lost-found\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const row = await rowWithReporter(decodeURIComponent(match[1]));
    if (!row || (row.reporter_id !== user.id && await isBlocked(user.id, row.reporter_id))) throw httpError(404, 'Item not found.');
    res.json({ item: serialize(row) });
    return true;
  });

  registerRoute('PATCH', /^\/api\/lost-found\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const entryId = decodeURIComponent(match[1]);
    const row = await rowWithReporter(entryId);
    if (!row) throw httpError(404, 'Item not found.');
    if (row.reporter_id !== user.id && !['owner', 'management'].includes(user.role)) throw httpError(403, 'You cannot edit this item.');
    const input = await readBody(req, 700000);
    const status = input.status === undefined ? row.status : (STATUSES.has(input.status) ? input.status : null);
    if (!status) throw httpError(400, 'Invalid Lost & Found status.');
    const name = input.name === undefined ? row.name : clean(input.name, 100);
    const description = input.description === undefined ? row.description : clean(input.description, 1000);
    if (!name || !description) throw httpError(400, 'Add an item name and description.');
    const oldMediaId = row.media_id;
    let newMedia = null;
    await db.transaction(async tx => {
      if (input.image) newMedia = await storeImage(row.reporter_id, input.image, tx);
      await tx.run(
        'UPDATE lost_found_entries SET status=?,name=?,description=?,location=?,media_id=?,updated_at=? WHERE id=?',
        [status, name, description, input.location === undefined ? row.location : clean(input.location, 120), newMedia?.id || oldMediaId, now(), entryId]
      );
      if (newMedia && oldMediaId) await deleteOrphanMedia([oldMediaId], tx);
    });
    emit('lost_found', { id: entryId, action: 'updated', status });
    res.json({ item: serialize(await rowWithReporter(entryId)) });
    return true;
  });

  registerRoute('POST', /^\/api\/lost-found\/([^/]+)\/contact$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const row = await rowWithReporter(decodeURIComponent(match[1]));
    if (!row) throw httpError(404, 'Item not found.');
    if (row.reporter_id === user.id) throw httpError(400, 'This is your report.');
    if (row.status === 'returned') throw httpError(409, 'This item has already been returned.');
    const { conversation } = await getOrCreateConversation(user.id, row.reporter_id);
    res.json({ conversationId: conversation.id });
    return true;
  });
}

module.exports = { registerRoutes, listEntries, createEntry, rowWithReporter, STATUSES };
