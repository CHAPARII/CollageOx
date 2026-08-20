const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const temp = path.join(__dirname, '.tmp-pr8-dm');
fs.rmSync(temp, { recursive: true, force: true });
fs.mkdirSync(temp, { recursive: true });
process.env.DB_FILE = path.join(temp, 'test.db');
process.env.OWNER_USERNAME = 'Pr8DmOwner';
process.env.OWNER_INITIAL_PASSWORD = 'pr8-dm-owner-password';
process.env.OWNER_EMAIL = 'dmowner@college.edu';
process.env.OWNER_NAME = 'PR8 DM Owner';

require('../src/runtime-enhancements');
require('../src/pr8');
const { server, db, ready } = require('../server');

let base;
let alice;
let bob;

async function request(url, options = {}) {
  const response = await fetch(base + url, options);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function register(username, name) {
  const { response, data } = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, username, email: `${username.replaceAll('.', '')}@college.edu`, password: 'student-secure-password' })
  });
  assert.equal(response.status, 201);
  return { cookie: response.headers.get('set-cookie').split(';')[0], user: data.user };
}

const jsonHeaders = cookie => ({ 'Content-Type': 'application/json', Cookie: cookie });

test.before(async () => {
  await ready;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  alice = await register('dm.alice', 'DM Alice');
  bob = await register('dm.bob', 'DM Bob');
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('one-to-one messages are immutable and support Seen receipts', async () => {
  const opened = await request('/api/dm/conversations', {
    method: 'POST', headers: jsonHeaders(alice.cookie), body: JSON.stringify({ username: bob.user.username })
  });
  assert.equal(opened.response.status, 201);
  const conversationId = opened.data.conversation.id;

  const sent = await request(`/api/dm/${conversationId}/messages`, {
    method: 'POST', headers: jsonHeaders(alice.cookie), body: JSON.stringify({ body: 'Hello Bob' })
  });
  assert.equal(sent.response.status, 201);
  assert.equal(sent.data.message.body, 'Hello Bob');
  assert.equal(sent.data.message.seenAt, null);

  const edit = await request(`/api/dm/${conversationId}/messages/${sent.data.message.id}`, {
    method: 'PATCH', headers: jsonHeaders(alice.cookie), body: JSON.stringify({ body: 'Changed' })
  });
  assert.ok([404, 405].includes(edit.response.status));

  const remove = await request(`/api/dm/${conversationId}/messages/${sent.data.message.id}`, {
    method: 'DELETE', headers: jsonHeaders(alice.cookie), body: '{}'
  });
  assert.ok([404, 405].includes(remove.response.status));

  const inboxBefore = await request('/api/dm/conversations', { headers: { Cookie: bob.cookie } });
  assert.equal(inboxBefore.data.conversations[0].unread, 1);

  const seen = await request(`/api/dm/${conversationId}/seen`, { method: 'POST', headers: jsonHeaders(bob.cookie), body: '{}' });
  assert.equal(seen.response.status, 200);

  const senderInbox = await request('/api/dm/conversations', { headers: { Cookie: alice.cookie } });
  assert.ok(senderInbox.data.conversations[0].latestMessage.seenAt);
});

test('muting a conversation suppresses DM notifications but keeps messages', async () => {
  const opened = await request('/api/dm/conversations', {
    method: 'POST', headers: jsonHeaders(alice.cookie), body: JSON.stringify({ username: bob.user.username })
  });
  const conversationId = opened.data.conversation.id;

  const muted = await request(`/api/dm/${conversationId}/settings`, {
    method: 'PATCH', headers: jsonHeaders(bob.cookie), body: JSON.stringify({ muted: true })
  });
  assert.equal(muted.response.status, 200);
  assert.equal(muted.data.muted, true);

  await db.run("DELETE FROM notifications WHERE user_id=? AND kind='dm_message'", [bob.user.id]);
  const sent = await request(`/api/dm/${conversationId}/messages`, {
    method: 'POST', headers: jsonHeaders(alice.cookie), body: JSON.stringify({ body: 'Muted message' })
  });
  assert.equal(sent.response.status, 201);
  assert.equal(await db.get("SELECT id FROM notifications WHERE user_id=? AND kind='dm_message'", [bob.user.id]), null);

  const history = await request(`/api/dm/${conversationId}/messages`, { headers: { Cookie: bob.cookie } });
  assert.ok(history.data.messages.some(message => message.body === 'Muted message'));
});

test('user feed mutes can be listed and reversed', async () => {
  const muted = await request('/api/safety/mutes', {
    method: 'PATCH', headers: jsonHeaders(alice.cookie),
    body: JSON.stringify({ targetType: 'user', targetId: bob.user.id, muted: true })
  });
  assert.equal(muted.response.status, 200);
  assert.equal(muted.data.muted, true);

  const listed = await request('/api/safety/mutes?targetType=user', { headers: { Cookie: alice.cookie } });
  assert.equal(listed.response.status, 200);
  assert.ok(listed.data.mutes.some(item => item.id === bob.user.id));

  const unmuted = await request('/api/safety/mutes', {
    method: 'PATCH', headers: jsonHeaders(alice.cookie),
    body: JSON.stringify({ targetType: 'user', targetId: bob.user.id, muted: false })
  });
  assert.equal(unmuted.response.status, 200);
  assert.equal(unmuted.data.muted, false);

  const after = await request('/api/safety/mutes?targetType=user', { headers: { Cookie: alice.cookie } });
  assert.equal(after.data.mutes.some(item => item.id === bob.user.id), false);
});

test('blocking immediately prevents new DM interaction and removes follows', async () => {
  await db.run('INSERT INTO follows (follower_id,following_id,created_at) VALUES (?,?,?)', [alice.user.id, bob.user.id, new Date().toISOString()]);
  const blocked = await request(`/api/safety/blocks/${bob.user.id}`, { method: 'PUT', headers: jsonHeaders(alice.cookie), body: '{}' });
  assert.equal(blocked.response.status, 200);
  assert.equal(blocked.data.blocked, true);
  assert.equal(await db.get('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?', [alice.user.id, bob.user.id]), null);

  const opened = await request('/api/dm/conversations', {
    method: 'POST', headers: jsonHeaders(alice.cookie), body: JSON.stringify({ username: bob.user.username })
  });
  assert.equal(opened.response.status, 403);

  const search = await request('/api/search?q=DM%20Bob&type=people', { headers: { Cookie: alice.cookie } });
  assert.equal(search.response.status, 200);
  assert.equal(search.data.items.some(item => item.id === bob.user.id), false);
});

test('blocked users can be listed and unblocked from safety settings', async () => {
  const listed = await request('/api/safety/blocks', { headers: { Cookie: alice.cookie } });
  assert.equal(listed.response.status, 200);
  assert.ok(listed.data.blocks.some(item => item.id === bob.user.id));

  const unblocked = await request(`/api/safety/blocks/${bob.user.id}`, {
    method: 'DELETE', headers: jsonHeaders(alice.cookie)
  });
  assert.equal(unblocked.response.status, 200);
  assert.equal(unblocked.data.blocked, false);

  const after = await request('/api/safety/blocks', { headers: { Cookie: alice.cookie } });
  assert.equal(after.data.blocks.some(item => item.id === bob.user.id), false);

  const search = await request('/api/search?q=DM%20Bob&type=people', { headers: { Cookie: alice.cookie } });
  assert.equal(search.response.status, 200);
  assert.ok(search.data.items.some(item => item.id === bob.user.id));
});
