const { db, now, id, clean, readBody, requireUser, httpError } = require('./common');
const { visiblePost } = require('./social');
const { emit } = require('./event-hub');

const ALLOWED_MIME = new Set(['image/webp', 'image/jpeg', 'image/png']);
const MAX_IMAGE_BYTES = 350000;
const MAX_TOTAL_BYTES = 1200000;
const MAX_POST_IMAGES = 4;

function parseImageData(data) {
  const value = String(data || '');
  const match = value.match(/^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/);
  if (!match || !ALLOWED_MIME.has(match[1])) throw httpError(400, 'Use a WebP, JPEG, or PNG image.');
  let bytes;
  try { bytes = Buffer.from(match[2], 'base64'); }
  catch { throw httpError(400, 'Invalid image data.'); }
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw httpError(413, 'Each compressed image must be under 350 KB.');
  return { mimeType: match[1], bytes: bytes.length, data: value };
}

async function storeImage(ownerId, input, tx = db) {
  const parsed = parseImageData(input.data);
  const width = Math.min(6000, Math.max(1, Number(input.width) || 1));
  const height = Math.min(6000, Math.max(1, Number(input.height) || 1));
  const mediaId = id('media');
  await tx.run(
    `INSERT INTO media (id,owner_id,provider,mime_type,data,size_bytes,width,height,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [mediaId, ownerId, 'database', parsed.mimeType, parsed.data, parsed.bytes, Math.round(width), Math.round(height), now()]
  );
  return { id: mediaId, mimeType: parsed.mimeType, src: parsed.data, sizeBytes: parsed.bytes, width: Math.round(width), height: Math.round(height) };
}

async function deleteOrphanMedia(mediaIds, tx = db) {
  for (const mediaId of mediaIds) {
    const used = await tx.get('SELECT 1 FROM post_media WHERE media_id=?', [mediaId]);
    const marketplace = await tx.get('SELECT 1 FROM marketplace_listings WHERE media_id=?', [mediaId]);
    const lostFound = await tx.get('SELECT 1 FROM lost_found_entries WHERE media_id=?', [mediaId]);
    if (!used && !marketplace && !lostFound) await tx.run('DELETE FROM media WHERE id=?', [mediaId]);
  }
}

async function replacePostMedia(userId, postId, images) {
  const post = await db.get('SELECT * FROM posts WHERE id=?', [postId]);
  if (!post) throw httpError(404, 'Post not found.');
  if (post.author_id !== userId) throw httpError(403, 'You can only change images on your own post.');
  const list = Array.isArray(images) ? images : [];
  if (list.length > MAX_POST_IMAGES) throw httpError(400, 'A post can have up to four images.');
  const parsed = list.map(image => parseImageData(image?.data));
  const total = parsed.reduce((sum, item) => sum + item.bytes, 0);
  if (total > MAX_TOTAL_BYTES) throw httpError(413, 'Compressed post images are too large together.');
  const old = await db.all('SELECT media_id FROM post_media WHERE post_id=?', [postId]);
  const created = [];
  await db.transaction(async tx => {
    await tx.run('DELETE FROM post_media WHERE post_id=?', [postId]);
    for (let position = 0; position < list.length; position++) {
      const media = await storeImage(userId, list[position], tx);
      created.push(media);
      await tx.run('INSERT INTO post_media (post_id,media_id,position) VALUES (?,?,?)', [postId, media.id, position]);
    }
    await deleteOrphanMedia(old.map(row => row.media_id), tx);
  });
  emit('post', { id: postId, mediaChanged: true });
  return created;
}

function registerRoutes(registerRoute) {
  registerRoute('PUT', /^\/api\/posts\/([^/]+)\/media$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const input = await readBody(req, 1800000);
    const media = await replacePostMedia(user.id, decodeURIComponent(match[1]), input.images);
    res.json({ media });
    return true;
  });

  registerRoute('GET', /^\/api\/media\/([^/]+)$/, async ({ req, res, match }) => {
    await requireUser(req);
    const row = await db.get('SELECT id,mime_type,data,size_bytes,width,height FROM media WHERE id=?', [decodeURIComponent(match[1])]);
    if (!row) throw httpError(404, 'Image not found.');
    res.json({ media: { id: row.id, mimeType: row.mime_type, src: row.data, sizeBytes: Number(row.size_bytes), width: row.width, height: row.height } });
    return true;
  });

  registerRoute('DELETE', /^\/api\/posts\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const postId = decodeURIComponent(match[1]);
    const post = await db.get('SELECT * FROM posts WHERE id=?', [postId]);
    if (!post) throw httpError(404, 'Post not found.');
    const staff = ['owner', 'management'].includes(user.role);
    if (post.author_id !== user.id && !staff) throw httpError(403, 'You cannot delete this post.');
    const mediaRows = await db.all('SELECT media_id FROM post_media WHERE post_id=?', [postId]);
    await db.transaction(async tx => {
      await tx.run('DELETE FROM posts WHERE id=?', [postId]);
      await deleteOrphanMedia(mediaRows.map(row => row.media_id), tx);
    });
    emit('deletePost', { id: postId });
    res.json({ ok: true });
    return true;
  });
}

module.exports = {
  registerRoutes,
  parseImageData,
  storeImage,
  replacePostMedia,
  deleteOrphanMedia,
  ALLOWED_MIME,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  MAX_POST_IMAGES
};