const crypto = require('node:crypto');
const { db, now, id, clean, readBody, requireUser, httpError } = require('./common');

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function fromB64url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(normalized + padding, 'base64');
}

function hkdfExtract(salt, ikm) {
  return crypto.createHmac('sha256', salt).update(ikm).digest();
}

function hkdfExpand(prk, info, length) {
  let output = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  let counter = 1;
  while (output.length < length) {
    previous = crypto.createHmac('sha256', prk).update(Buffer.concat([previous, info, Buffer.from([counter++])])).digest();
    output = Buffer.concat([output, previous]);
  }
  return output.subarray(0, length);
}

function vapidConfig() {
  const publicKey = clean(process.env.VAPID_PUBLIC_KEY, 200);
  const privateKey = clean(process.env.VAPID_PRIVATE_KEY, 200);
  const subject = clean(process.env.VAPID_SUBJECT, 300) || 'mailto:admin@collegeox.local';
  return { publicKey, privateKey, subject, enabled: !!(publicKey && privateKey) };
}

function vapidAuthorization(endpoint, config = vapidConfig()) {
  if (!config.enabled) return null;
  const publicRaw = fromB64url(config.publicKey);
  const privateRaw = fromB64url(config.privateKey);
  if (publicRaw.length !== 65 || publicRaw[0] !== 4 || privateRaw.length !== 32) throw new Error('Invalid VAPID key configuration.');
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: b64url(publicRaw.subarray(1, 33)),
    y: b64url(publicRaw.subarray(33, 65)),
    d: b64url(privateRaw)
  };
  const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(Buffer.from(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: config.subject
  })));
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64url(signature)}, k=${config.publicKey}`;
}

function encryptPayload(subscription, payload) {
  const clientPublic = fromB64url(subscription.p256dh);
  const authSecret = fromB64url(subscription.auth);
  if (clientPublic.length !== 65 || clientPublic[0] !== 4 || authSecret.length < 16) throw new Error('Invalid push subscription keys.');

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const serverPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(clientPublic);
  const authPrk = hkdfExtract(authSecret, sharedSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), clientPublic, serverPublic]);
  const ikm = hkdfExpand(authPrk, keyInfo, 32);
  const salt = crypto.randomBytes(16);
  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const plaintext = Buffer.concat([Buffer.from(JSON.stringify(payload)), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, recordSize, Buffer.from([serverPublic.length]), serverPublic, encrypted]);
}

async function sendSubscription(subscription, payload) {
  const config = vapidConfig();
  if (!config.enabled) return { delivered: false, disabled: true };
  const body = encryptPayload(subscription, payload);
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(subscription.endpoint, config),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400'
    },
    body
  });
  return { delivered: response.ok, status: response.status, gone: response.status === 404 || response.status === 410 };
}

async function deliverPush(userId, notification) {
  const config = vapidConfig();
  if (!config.enabled) return { delivered: false, disabled: true, attempts: 0 };
  const rows = await db.all('SELECT * FROM push_subscriptions WHERE user_id=?', [userId]);
  let delivered = 0;
  let attempts = 0;
  for (const row of rows) {
    attempts++;
    try {
      const result = await sendSubscription(row, notification);
      if (result.delivered) delivered++;
      if (result.gone) await db.run('DELETE FROM push_subscriptions WHERE id=?', [row.id]);
    } catch (error) {
      console.error(`Push delivery failed: ${error.message}`);
    }
  }
  return { delivered: delivered > 0, deliveredCount: delivered, attempts };
}

function registerRoutes(registerRoute) {
  registerRoute('GET', '/api/push/config', async ({ req, res }) => {
    await requireUser(req);
    const config = vapidConfig();
    res.json({ enabled: config.enabled, publicKey: config.enabled ? config.publicKey : '' });
    return true;
  });

  registerRoute('POST', '/api/push/subscriptions', async ({ req, res }) => {
    const user = await requireUser(req);
    const input = await readBody(req, 12000);
    let endpoint;
    try { endpoint = new URL(String(input.endpoint || '')); } catch { throw httpError(400, 'Invalid push endpoint.'); }
    if (endpoint.protocol !== 'https:') throw httpError(400, 'Push endpoint must use HTTPS.');
    const p256dh = clean(input.keys?.p256dh, 300);
    const auth = clean(input.keys?.auth, 200);
    if (!p256dh || !auth) throw httpError(400, 'Push subscription keys are missing.');
    const existing = await db.get('SELECT id FROM push_subscriptions WHERE endpoint=?', [endpoint.toString()]);
    const subscriptionId = existing?.id || id('push');
    const timestamp = now();
    await db.run(
      `INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET
       user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,updated_at=excluded.updated_at`,
      [subscriptionId, user.id, endpoint.toString(), p256dh, auth, timestamp, timestamp]
    );
    res.json({ ok: true, id: subscriptionId }, existing ? 200 : 201);
    return true;
  });

  registerRoute('DELETE', '/api/push/subscriptions', async ({ req, res }) => {
    const user = await requireUser(req);
    const input = await readBody(req, 12000);
    const endpoint = clean(input.endpoint, 2000);
    if (!endpoint) throw httpError(400, 'Push endpoint is required.');
    await db.run('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?', [user.id, endpoint]);
    res.json({ ok: true });
    return true;
  });
}

module.exports = {
  registerRoutes,
  vapidConfig,
  vapidAuthorization,
  encryptPayload,
  sendSubscription,
  deliverPush,
  b64url,
  fromB64url,
  hkdfExtract,
  hkdfExpand
};
