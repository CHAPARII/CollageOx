const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const temp = path.join(__dirname, '.tmp-pr8-foundation');
fs.rmSync(temp, { recursive: true, force: true });
fs.mkdirSync(temp, { recursive: true });
process.env.DB_FILE = path.join(temp, 'test.db');
process.env.OWNER_USERNAME = 'Pr8Owner';
process.env.OWNER_INITIAL_PASSWORD = 'pr8-owner-secure-password';
process.env.OWNER_EMAIL = 'owner@college.edu';
process.env.OWNER_NAME = 'PR8 Owner';

require('../src/runtime-enhancements');
require('../src/pr8/index');
const { pageLimit } = require('../src/pr8/common');
const { server, db, ready } = require('../server');

let base;

test.before(async () => {
  await ready;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.close().catch(() => {});
  fs.rmSync(temp, { recursive: true, force: true });
});

async function request(url, options = {}) {
  const response = await fetch(base + url, options);
  const data = await response.json().catch(() => ({}));
  return { response, data };
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

function auth(cookie) {
  return { cookie, 'Content-Type': 'application/json' };
}

test('omitted page limits use endpoint fallbacks instead of collapsing to one item', () => {
  assert.equal(pageLimit(null, 40, 100), 40);
  assert.equal(pageLimit(undefined, 30, 80), 30);
  assert.equal(pageLimit('', 20, 50), 20);
  assert.equal(pageLimit('7', 20, 50), 7);
});

test('notification inbox returns its default page when limit is omitted', async () => {
  const user = await register('notice.default');
  const timestamp = new Date().toISOString();
  await db.run(
    'INSERT INTO notifications (id,user_id,actor_id,kind,entity_id,text,created_at) VALUES (?,?,?,?,?,?,?)',
    ['notice_default_1', user.user.id, null, 'system', 'one', 'First notice', timestamp]
  );
  await db.run(
    'INSERT INTO notifications (id,user_id,actor_id,kind,entity_id,text,created_at) VALUES (?,?,?,?,?,?,?)',
    ['notice_default_2', user.user.id, null, 'system', 'two', 'Second notice', new Date(Date.now() + 1).toISOString()]
  );
  const result = await request('/api/notifications', { headers: auth(user.cookie) });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.notifications.length, 2);
  assert.equal(result.data.unread, 2);
});

test('migrations 4 through 9 are applied on a fresh database', async () => {
  const rows = await db.all('SELECT version,name FROM schema_migrations WHERE version>=4 ORDER BY version');
  assert.deepEqual(rows.map(row => Number(row.version)), [4, 5, 6, 7, 8, 9]);
  for (const table of [
    'user_blocks', 'user_presence', 'dm_conversations', 'dm_messages',
    'user_skills', 'polls', 'project_applications', 'club_membership_requests',
    'marketplace_listings', 'lost_found_entries', 'questions', 'event_reminders', 'push_subscriptions'
  ]) {
    assert.ok(await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table]), table);
  }
});

test('one to one DMs are immutable, unread-aware, seen-aware and mutable only at conversation settings level', async () => {
  const alice = await register('dm.alice');
  const bob = await register('dm.bob');

  let result = await request('/api/dm/conversations', {
    method: 'POST',
    headers: auth(alice.cookie),
    body: JSON.stringify({ userId: bob.user.id })
  });
  assert.equal(result.response.status, 201);
  const conversationId = result.data.conversation.id;

  result = await request(`/api/dm/${conversationId}/messages`, {
    method: 'POST',
    headers: auth(alice.cookie),
    body: JSON.stringify({ body: 'hello bob' })
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.message.body, 'hello bob');
  assert.equal(result.data.message.seenAt, null);
  const messageId = result.data.message.id;

  result = await request('/api/dm/conversations', { headers: auth(bob.cookie) });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.conversations[0].unread, 1);

  result = await request(`/api/dm/${conversationId}/seen`, {
    method: 'POST',
    headers: auth(bob.cookie),
    body: '{}'
  });
  assert.equal(result.response.status, 200);

  result = await request(`/api/dm/${conversationId}/messages`, { headers: auth(alice.cookie) });
  assert.equal(result.response.status, 200);
  assert.ok(result.data.messages.find(message => message.id === messageId).seenAt);

  result = await request(`/api/dm/${conversationId}/settings`, {
    method: 'PATCH',
    headers: auth(bob.cookie),
    body: JSON.stringify({ muted: true })
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.muted, true);

  result = await request(`/api/dm/${conversationId}/messages/${messageId}`, {
    method: 'DELETE',
    headers: auth(alice.cookie)
  });
  assert.equal(result.response.status, 404);

  result = await request(`/api/dm/${conversationId}/messages/${messageId}`, {
    method: 'PATCH',
    headers: auth(alice.cookie),
    body: JSON.stringify({ body: 'edited' })
  });
  assert.equal(result.response.status, 404);
});

test('blocking prevents new direct messages in either direction', async () => {
  const first = await register('block.first');
  const second = await register('block.second');

  let result = await request(`/api/safety/blocks/${second.user.id}`, {
    method: 'PUT',
    headers: auth(first.cookie),
    body: '{}'
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.blocked, true);

  result = await request('/api/dm/conversations', {
    method: 'POST',
    headers: auth(second.cookie),
    body: JSON.stringify({ userId: first.user.id })
  });
  assert.equal(result.response.status, 403);

  result = await request(`/api/safety/blocks/${second.user.id}`, {
    method: 'DELETE',
    headers: auth(first.cookie)
  });
  assert.equal(result.response.status, 200);

  result = await request('/api/dm/conversations', {
    method: 'POST',
    headers: auth(second.cookie),
    body: JSON.stringify({ userId: first.user.id })
  });
  assert.equal(result.response.status, 201);
});

test('presence is visible to signed in users and updates on activity', async () => {
  const one = await register('presence.one');
  const two = await register('presence.two');

  let result = await request('/api/presence', {
    method: 'POST',
    headers: auth(one.cookie),
    body: '{}'
  });
  assert.equal(result.response.status, 200);

  result = await request(`/api/presence?ids=${encodeURIComponent(one.user.id)}`, { headers: auth(two.cookie) });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.presence[0].userId, one.user.id);
  assert.equal(result.data.presence[0].online, true);
  assert.ok(result.data.presence[0].lastSeenAt);
});
