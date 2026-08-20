const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const temp = path.join(__dirname, '.tmp-pr8-clubs');
fs.rmSync(temp, { recursive: true, force: true });
fs.mkdirSync(temp, { recursive: true });
process.env.DB_FILE = path.join(temp, 'test.db');
process.env.OWNER_USERNAME = 'Pr8ClubOwner';
process.env.OWNER_INITIAL_PASSWORD = 'pr8-club-owner-password';
process.env.OWNER_EMAIL = 'clubowner@college.edu';
process.env.OWNER_NAME = 'PR8 Club Owner';

require('../src/runtime-enhancements');
require('../src/pr8');
const { server, db, ready } = require('../server');

let base;
let owner;
let member;
let invited;

async function request(url, options = {}) {
  const response = await fetch(base + url, options);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function login(login, password) {
  const { response, data } = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, password })
  });
  assert.equal(response.status, 200);
  return { cookie: response.headers.get('set-cookie').split(';')[0], user: data.user };
}

async function register(username) {
  const { response, data } = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: username.replace('.', ' '),
      username,
      email: `${username.replaceAll('.', '')}@college.edu`,
      password: 'student-secure-password'
    })
  });
  assert.equal(response.status, 201);
  return { cookie: response.headers.get('set-cookie').split(';')[0], user: data.user };
}

const jsonHeaders = cookie => ({ 'Content-Type': 'application/json', Cookie: cookie });

async function createClub(name) {
  const result = await request('/api/clubs', {
    method: 'POST',
    headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ name, description: `${name} description`, category: 'Technology', accent: '#155eef' })
  });
  assert.equal(result.response.status, 201);
  assert.ok(result.data.club?.id);
  return result.data.club.id;
}

test.before(async () => {
  await ready;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await login('Pr8ClubOwner', 'pr8-club-owner-password');
  member = await register('club.member');
  invited = await register('club.invited');
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('club list keeps club name separate from owner name', async () => {
  const clubId = await createClub('Robotics Society');
  const listed = await request('/api/clubs', { headers: { Cookie: owner.cookie } });
  assert.equal(listed.response.status, 200);
  const club = listed.data.clubs.find(item => item.id === clubId);
  assert.ok(club);
  assert.equal(club.name, 'Robotics Society');
  assert.equal(club.ownerName, 'PR8 Club Owner');
});

test('approval clubs require a message and owner decision', async () => {
  const clubId = await createClub('Design Society');
  const mode = await request(`/api/clubs/${clubId}/join-settings`, {
    method: 'PATCH',
    headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ mode: 'approval' })
  });
  assert.equal(mode.response.status, 200);

  const missing = await request(`/api/clubs/${clubId}/join`, {
    method: 'POST',
    headers: jsonHeaders(member.cookie),
    body: '{}'
  });
  assert.equal(missing.response.status, 400);

  const pending = await request(`/api/clubs/${clubId}/join`, {
    method: 'POST',
    headers: jsonHeaders(member.cookie),
    body: JSON.stringify({ message: 'I want to help with design events.' })
  });
  assert.equal(pending.response.status, 202);
  assert.equal(pending.data.status, 'pending');

  const requests = await request(`/api/clubs/${clubId}/requests`, { headers: { Cookie: owner.cookie } });
  assert.equal(requests.response.status, 200);
  assert.equal(requests.data.requests.length, 1);

  const accepted = await request(`/api/clubs/${clubId}/requests/${requests.data.requests[0].id}`, {
    method: 'PATCH',
    headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ status: 'accepted' })
  });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.data.status, 'accepted');

  const members = await request(`/api/clubs/${clubId}/members`, { headers: { Cookie: member.cookie } });
  assert.equal(members.response.status, 200);
  assert.ok(members.data.members.some(item => item.id === member.user.id));
});

test('invite-only clubs reject uninvited users and accept invited users', async () => {
  const clubId = await createClub('Private Builders');
  const mode = await request(`/api/clubs/${clubId}/join-settings`, {
    method: 'PATCH',
    headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ mode: 'invite' })
  });
  assert.equal(mode.response.status, 200);

  const blockedJoin = await request(`/api/clubs/${clubId}/join`, {
    method: 'POST',
    headers: jsonHeaders(invited.cookie),
    body: '{}'
  });
  assert.equal(blockedJoin.response.status, 403);

  const invite = await request(`/api/clubs/${clubId}/invites`, {
    method: 'POST',
    headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ username: invited.user.username })
  });
  assert.equal(invite.response.status, 201);
  assert.equal(invite.data.invite.status, 'pending');

  const joined = await request(`/api/clubs/${clubId}/join`, {
    method: 'POST',
    headers: jsonHeaders(invited.cookie),
    body: '{}'
  });
  assert.equal(joined.response.status, 200);
  assert.equal(joined.data.joined, true);
});

test('club chat @mentions create mention notifications', async () => {
  const clubId = await createClub('Mention Lab');
  const joined = await request(`/api/clubs/${clubId}/join`, {
    method: 'POST',
    headers: jsonHeaders(member.cookie),
    body: '{}'
  });
  assert.equal(joined.response.status, 200);
  assert.equal(joined.data.joined, true);

  const sent = await request(`/api/clubs/${clubId}/messages`, {
    method: 'POST',
    headers: jsonHeaders(member.cookie),
    body: JSON.stringify({ body: 'Hello @Pr8ClubOwner, can you check this?' })
  });
  assert.equal(sent.response.status, 201);
  assert.ok(sent.data.message?.id);

  const mention = await db.get(
    "SELECT * FROM notifications WHERE user_id=? AND kind='mention' AND entity_id=?",
    [owner.user.id, sent.data.message.id]
  );
  assert.ok(mention);
});
