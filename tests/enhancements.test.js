const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const temp = path.join(__dirname, '.tmp-enhancements');
fs.rmSync(temp, { recursive: true, force: true });
fs.mkdirSync(temp, { recursive: true });
process.env.DB_FILE = path.join(temp, 'test.db');
process.env.OWNER_USERNAME = 'EnhOwner';
process.env.OWNER_INITIAL_PASSWORD = 'enh-owner-secure-password';
process.env.OWNER_EMAIL = 'owner@college.edu';
process.env.OWNER_NAME = 'Enh Owner';

require('../src/runtime-enhancements');
require('../src/pr8');
const { enhancedIndex } = require('../src/static-enhancements');
const { server, db, ready } = require('../server');

let base;

test.before(async () => {
  await ready;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

async function request(url, options = {}) {
  const response = await fetch(base + url, options);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function ownerCookie() {
  const { response } = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'EnhOwner', password: 'enh-owner-secure-password' })
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

async function register(username) {
  const { response, data } = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: username.replace('.', ' '),
      username,
      email: `${username.replaceAll('.', '')}@college.edu`,
      password: 'long-secure-password'
    })
  });
  assert.equal(response.status, 201);
  return { cookie: response.headers.get('set-cookie').split(';')[0], user: data.user };
}

test('migration v3 creates notification and report storage', async () => {
  const migration = await db.get('SELECT version,name FROM schema_migrations WHERE version=?', [3]);
  assert.equal(migration.version, 3);
  assert.equal(migration.name, 'stability_and_core_features');
  assert.ok(await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='notifications'"));
  assert.ok(await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='reports'"));
});

test('enhanced production shell adds readable assets and a new cache-busted app URL', () => {
  const html = enhancedIndex();
  assert.match(html, /enhancements\.css\?v=1/);
  assert.match(html, /enhancements\.js\?v=1/);
  assert.match(html, /app\.js\?v=3&build=pr8/);
  assert.match(html, /styles\.css\?v=3&build=pr8/);
});

test('likes and follows create notifications', async () => {
  const first = await register('notify.one');
  const second = await register('notify.two');
  let result = await request('/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: first.cookie },
    body: JSON.stringify({ body: 'Notification test post', type: 'post', tags: [] })
  });
  assert.equal(result.response.status, 201);
  const postId = result.data.post.id;
  assert.equal(await db.get('SELECT 1 FROM reactions WHERE post_id=? AND user_id=?', [postId, second.user.id]), null);
  result = await request(`/api/posts/${postId}/react`, { method: 'POST', headers: { cookie: second.cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(result.response.status, 200);
  assert.ok(await db.get('SELECT 1 FROM reactions WHERE post_id=? AND user_id=?', [postId, second.user.id]));
  const likeNotification = await db.get("SELECT id,actor_id,entity_id FROM notifications WHERE user_id=? AND kind='like'", [first.user.id]);
  assert.ok(likeNotification, JSON.stringify(await db.all('SELECT user_id,actor_id,kind,entity_id FROM notifications ORDER BY created_at')));
  result = await request(`/api/users/${first.user.id}/follow`, { method: 'POST', headers: { cookie: second.cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(result.response.status, 200);
  const directNotifications = await db.all('SELECT user_id,actor_id,kind,entity_id FROM notifications WHERE user_id=? ORDER BY created_at', [first.user.id]);
  assert.deepEqual(new Set(directNotifications.map(item => item.kind)), new Set(['like', 'follow']), JSON.stringify(directNotifications));
  result = await request('/api/notifications', { headers: { cookie: first.cookie } });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.unread, 2);
  assert.deepEqual(new Set(result.data.notifications.map(item => item.kind)), new Set(['like', 'follow']));
});

test('private-profile posts are excluded from other users feed and direct post view', async () => {
  const privateUser = await register('private.feed');
  const viewer = await register('feed.viewer');
  let result = await request('/api/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie: privateUser.cookie },
    body: JSON.stringify({ name: 'Private Feed', username: 'private.feed', profileVisibility: 'private', interests: [], links: [] })
  });
  assert.equal(result.response.status, 200);
  result = await request('/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: privateUser.cookie },
    body: JSON.stringify({ body: 'Private activity', type: 'post', tags: [] })
  });
  const postId = result.data.post.id;
  result = await request('/api/posts?limit=50', { headers: { cookie: viewer.cookie } });
  assert.equal(result.data.posts.some(post => post.id === postId), false);
  result = await request(`/api/posts/${postId}`, { headers: { cookie: viewer.cookie } });
  assert.equal(result.response.status, 404);
  result = await request(`/api/posts/${postId}`, { headers: { cookie: privateUser.cookie } });
  assert.equal(result.response.status, 200);
});

test('users can report a post and management can resolve the report', async () => {
  const reporter = await register('report.user');
  const target = await register('report.target');
  let result = await request('/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: target.cookie },
    body: JSON.stringify({ body: 'Report target', type: 'post', tags: [] })
  });
  const postId = result.data.post.id;
  result = await request('/api/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: reporter.cookie },
    body: JSON.stringify({ targetType: 'post', targetId: postId, reason: 'Please review this post.' })
  });
  assert.equal(result.response.status, 201);
  const owner = await ownerCookie();
  result = await request('/api/admin/reports', { headers: { cookie: owner } });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.reports.length, 1);
  const reportId = result.data.reports[0].id;
  result = await request(`/api/admin/reports/${reportId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie: owner },
    body: JSON.stringify({ status: 'resolved' })
  });
  assert.equal(result.response.status, 200);
});

test('event creator can edit and cancel an event', async () => {
  const creator = await register('event.owner');
  let result = await request('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: creator.cookie },
    body: JSON.stringify({ title: 'Original event', description: '', startsAt: new Date(Date.now() + 86400000).toISOString(), location: 'Room 1', capacity: 20 })
  });
  assert.equal(result.response.status, 201);
  const eventId = result.data.event.id;
  result = await request(`/api/events/${eventId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie: creator.cookie },
    body: JSON.stringify({ title: 'Updated event', startsAt: new Date(Date.now() + 172800000).toISOString(), capacity: 25 })
  });
  assert.equal(result.response.status, 200);
  result = await request('/api/events', { headers: { cookie: creator.cookie } });
  assert.equal(result.data.events.find(event => event.id === eventId).title, 'Updated event');
  result = await request(`/api/events/${eventId}`, { method: 'DELETE', headers: { cookie: creator.cookie } });
  assert.equal(result.response.status, 200);
  result = await request('/api/events', { headers: { cookie: creator.cookie } });
  assert.equal(result.data.events.some(event => event.id === eventId), false);
});