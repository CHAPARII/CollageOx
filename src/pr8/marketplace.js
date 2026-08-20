const { db, now, id, clean, readBody, requireUser, httpError } = require('./common');
const { isBlocked } = require('./safety');
const { storeImage, deleteOrphanMedia } = require('./media');
const { getOrCreateConversation } = require('./dm');
const { emit } = require('./event-hub');

const LISTING_TYPES = new Set(['sell', 'buy', 'borrow', 'giveaway']);
const LISTING_STATUSES = new Set(['active', 'reserved', 'sold', 'closed', 'expired']);

function serialize(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    owner: row.username ? { id: row.owner_id, username: row.username, name: row.name, avatar: row.avatar || '', accent: row.accent || '#155eef' } : null,
    type: row.listing_type,
    title: row.title,
    description: row.description,
    category: row.category,
    condition: row.item_condition,
    priceInr: row.price_inr == null ? null : Number(row.price_inr),
    location: row.location,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    image: row.media_id ? { id: row.media_id, src: row.media_data, mimeType: row.media_mime } : null
  };
}

async function listingWithOwner(listingId) {
  return await db.get(
    `SELECT m.*,u.username,u.name,u.avatar,u.accent,media.data media_data,media.mime_type media_mime
     FROM marketplace_listings m JOIN users u ON u.id=m.owner_id
     LEFT JOIN media ON media.id=m.media_id WHERE m.id=?`,
    [listingId]
  );
}

async function listMarketplace(user, url) {
  const mine = url.searchParams.get('mine') === '1';
  const requestedType = clean(url.searchParams.get('type'), 20).toLowerCase();
  const type = LISTING_TYPES.has(requestedType) ? requestedType : null;
  const statusParam = clean(url.searchParams.get('status'), 20).toLowerCase();
  const status = LISTING_STATUSES.has(statusParam) ? statusParam : null;
  const params = [];
  const where = [];
  if (mine) {
    where.push('m.owner_id=?');
    params.push(user.id);
  } else {
    where.push("m.status='active'");
    where.push('(m.expires_at IS NULL OR m.expires_at>?)');
    params.push(now());
  }
  if (type) { where.push('m.listing_type=?'); params.push(type); }
  if (status && mine) { where.push('m.status=?'); params.push(status); }
  const rows = await db.all(
    `SELECT m.*,u.username,u.name,u.avatar,u.accent,media.data media_data,media.mime_type media_mime
     FROM marketplace_listings m JOIN users u ON u.id=m.owner_id
     LEFT JOIN media ON media.id=m.media_id
     WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC LIMIT 120`,
    params
  );
  const output = [];
  for (const row of rows) {
    if (row.owner_id !== user.id && await isBlocked(user.id, row.owner_id)) continue;
    output.push(serialize(row));
  }
  return output;
}

async function createListing(user, input) {
  const type = LISTING_TYPES.has(input.type) ? input.type : null;
  if (!type) throw httpError(400, 'Choose Sell, Buy, Borrow, or Give away.');
  const title = clean(input.title, 100);
  const description = clean(input.description, 1000);
  if (!title || !description) throw httpError(400, 'Add a title and description.');
  let price = input.priceInr === '' || input.priceInr == null ? null : Math.round(Number(input.priceInr));
  if (price != null && (!Number.isFinite(price) || price < 0 || price > 100000000)) throw httpError(400, 'Enter a valid INR price.');
  if (type === 'giveaway') price = null;
  let expiresAt = input.expiresAt ? new Date(input.expiresAt) : new Date(Date.now() + 30 * 86400000);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) throw httpError(400, 'Choose a future expiry date.');
  const listingId = id('market');
  let media = null;
  await db.transaction(async tx => {
    if (input.image) media = await storeImage(user.id, input.image, tx);
    const timestamp = now();
    await tx.run(
      `INSERT INTO marketplace_listings
       (id,owner_id,listing_type,title,description,category,item_condition,price_inr,location,media_id,expires_at,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [listingId, user.id, type, title, description, clean(input.category, 60), clean(input.condition, 60), price, clean(input.location, 120), media?.id || null, expiresAt.toISOString(), 'active', timestamp, timestamp]
    );
  });
  emit('marketplace', { id: listingId, action: 'created' });
  return serialize(await listingWithOwner(listingId));
}

function registerRoutes(registerRoute) {
  registerRoute('GET', '/api/marketplace', async ({ req, res, url }) => {
    const user = await requireUser(req);
    res.json({ listings: await listMarketplace(user, url) });
    return true;
  });

  registerRoute('POST', '/api/marketplace', async ({ req, res }) => {
    const user = await requireUser(req);
    const input = await readBody(req, 700000);
    res.json({ listing: await createListing(user, input) }, 201);
    return true;
  });

  registerRoute('GET', /^\/api\/marketplace\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const row = await listingWithOwner(decodeURIComponent(match[1]));
    if (!row || (row.owner_id !== user.id && await isBlocked(user.id, row.owner_id))) throw httpError(404, 'Listing not found.');
    res.json({ listing: serialize(row) });
    return true;
  });

  registerRoute('PATCH', /^\/api\/marketplace\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const listingId = decodeURIComponent(match[1]);
    const row = await listingWithOwner(listingId);
    if (!row) throw httpError(404, 'Listing not found.');
    if (row.owner_id !== user.id && !['owner', 'management'].includes(user.role)) throw httpError(403, 'You cannot edit this listing.');
    const input = await readBody(req, 700000);
    const status = input.status === undefined ? row.status : (LISTING_STATUSES.has(input.status) ? input.status : null);
    if (!status) throw httpError(400, 'Invalid listing status.');
    const title = input.title === undefined ? row.title : clean(input.title, 100);
    const description = input.description === undefined ? row.description : clean(input.description, 1000);
    if (!title || !description) throw httpError(400, 'Add a title and description.');
    let price = input.priceInr === undefined ? row.price_inr : (input.priceInr === '' || input.priceInr == null ? null : Math.round(Number(input.priceInr)));
    if (price != null && (!Number.isFinite(price) || price < 0 || price > 100000000)) throw httpError(400, 'Enter a valid INR price.');
    if (row.listing_type === 'giveaway') price = null;
    let newMedia = null;
    const oldMediaId = row.media_id;
    await db.transaction(async tx => {
      if (input.image) newMedia = await storeImage(row.owner_id, input.image, tx);
      await tx.run(
        `UPDATE marketplace_listings SET title=?,description=?,category=?,item_condition=?,price_inr=?,location=?,media_id=?,status=?,updated_at=? WHERE id=?`,
        [title, description, input.category === undefined ? row.category : clean(input.category, 60), input.condition === undefined ? row.item_condition : clean(input.condition, 60), price, input.location === undefined ? row.location : clean(input.location, 120), newMedia?.id || oldMediaId, status, now(), listingId]
      );
      if (newMedia && oldMediaId) await deleteOrphanMedia([oldMediaId], tx);
    });
    emit('marketplace', { id: listingId, action: 'updated' });
    res.json({ listing: serialize(await listingWithOwner(listingId)) });
    return true;
  });

  registerRoute('POST', /^\/api\/marketplace\/([^/]+)\/contact$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const row = await listingWithOwner(decodeURIComponent(match[1]));
    if (!row) throw httpError(404, 'Listing not found.');
    if (row.owner_id === user.id) throw httpError(400, 'This is your listing.');
    if (row.status !== 'active') throw httpError(409, 'This listing is no longer active.');
    const { conversation } = await getOrCreateConversation(user.id, row.owner_id);
    res.json({ conversationId: conversation.id });
    return true;
  });
}

module.exports = { registerRoutes, listMarketplace, createListing, listingWithOwner, LISTING_TYPES, LISTING_STATUSES };
