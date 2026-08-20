const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const temp = path.join(__dirname, '.tmp-pr8-push');
fs.rmSync(temp, { recursive: true, force: true });
fs.mkdirSync(temp, { recursive: true });
process.env.DB_FILE = path.join(temp, 'test.db');
process.env.OWNER_USERNAME = 'Pr8PushOwner';
process.env.OWNER_INITIAL_PASSWORD = 'pr8-push-owner-password';
process.env.OWNER_EMAIL = 'pushowner@college.edu';
process.env.OWNER_NAME = 'PR8 Push Owner';

require('../src/runtime-enhancements');
require('../src/pr8');
const { server, db, ready } = require('../server');
const { notify } = require('../src/pr8/notifications');
const { b64url } = require('../src/pr8/push');

let base;
let student;

async function request(url, options = {}) {
  const response = await fetch(base + url, options);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function register(username) {
  const { response, data } = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Push Student', username, email: `${username}@college.edu`, password: 'student-secure-password' })
  });
  assert.equal(response.status, 201);
  return data.user;
}

test.before(async () => {
  await ready;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  student = await register('push.student');
});

test.after(async () => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
  await new Promise(resolve => server.close(resolve));
  await db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('notification writes remain successful when push is not configured', async () => {
  const notificationId = await notify({ userId: student.id, kind: 'mention', entityId: 'post_1', text: 'You were mentioned.', category: 'mentions' });
  assert.ok(notificationId);
  const row = await db.get('SELECT id,text FROM notifications WHERE id=?', [notificationId]);
  assert.equal(row.text, 'You were mentioned.');
});

test('eligible notifications attempt Web Push without blocking the notification write', async () => {
  const vapid = crypto.createECDH('prime256v1');
  vapid.generateKeys();
  process.env.VAPID_PUBLIC_KEY = b64url(vapid.getPublicKey());
  process.env.VAPID_PRIVATE_KEY = b64url(vapid.getPrivateKey());
  process.env.VAPID_SUBJECT = 'mailto:test@college.edu';

  const client = crypto.createECDH('prime256v1');
  client.generateKeys();
  await db.run(
    `INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    ['push_test', student.id, 'https://push.example.test/send', b64url(client.getPublicKey()), b64url(crypto.randomBytes(16)), new Date().toISOString(), new Date().toISOString()]
  );

  const originalFetch = global.fetch;
  let attempts = 0;
  global.fetch = async () => {
    attempts++;
    return { ok: true, status: 201 };
  };
  try {
    const notificationId = await notify({ userId: student.id, kind: 'dm_message', entityId: 'dm_1', text: 'New message.', category: 'dm' });
    assert.ok(notificationId);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(attempts, 1);
    assert.ok(await db.get('SELECT id FROM notifications WHERE id=?', [notificationId]));
  } finally {
    global.fetch = originalFetch;
  }
});
