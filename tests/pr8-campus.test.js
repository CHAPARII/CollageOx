const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const temp = path.join(__dirname, '.tmp-pr8-campus');
fs.rmSync(temp, { recursive: true, force: true });
fs.mkdirSync(temp, { recursive: true });
process.env.DB_FILE = path.join(temp, 'test.db');
process.env.OWNER_USERNAME = 'Pr8CampusOwner';
process.env.OWNER_INITIAL_PASSWORD = 'pr8-campus-owner-password';
process.env.OWNER_EMAIL = 'campusowner@college.edu';
process.env.OWNER_NAME = 'PR8 Campus Owner';

require('../src/runtime-enhancements');
require('../src/pr8');
const { server, db, ready } = require('../server');

let base;
let owner;
let alice;
let bob;

async function request(url, options = {}) {
  const response = await fetch(base + url, options);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function login(login, password) {
  const { response, data } = await request('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password })
  });
  assert.equal(response.status, 200);
  return { cookie: response.headers.get('set-cookie').split(';')[0], user: data.user };
}

async function register(username, name) {
  const { response, data } = await request('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
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
  owner = await login('Pr8CampusOwner', 'pr8-campus-owner-password');
  alice = await register('campus.alice', 'Campus Alice');
  bob = await register('campus.bob', 'Campus Bob');
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('anonymous Q&A hides the author publicly but exposes the correct author to management', async () => {
  const created = await request('/api/questions', {
    method: 'POST', headers: jsonHeaders(alice.cookie),
    body: JSON.stringify({ title: 'Where is the robotics lab?', body: 'I need the room number.', anonymous: true })
  });
  assert.equal(created.response.status, 201);
  const questionId = created.data.question.id;
  assert.equal(created.data.question.author, null);

  const publicView = await request(`/api/questions/${questionId}`, { headers: { Cookie: bob.cookie } });
  assert.equal(publicView.response.status, 200);
  assert.equal(publicView.data.question.author, null);

  const moderationView = await request(`/api/questions/${questionId}?moderation=1`, { headers: { Cookie: owner.cookie } });
  assert.equal(moderationView.response.status, 200);
  assert.equal(moderationView.data.question.author.id, alice.user.id);
  assert.equal(moderationView.data.question.author.username, alice.user.username);
});

test('Q&A answers stay attributed, can be upvoted, and can be accepted by the question author', async () => {
  const created = await request('/api/questions', {
    method: 'POST', headers: jsonHeaders(alice.cookie),
    body: JSON.stringify({ title: 'Library timing?', body: 'When does it close?', anonymous: false })
  });
  const questionId = created.data.question.id;

  const answered = await request(`/api/questions/${questionId}/answers`, {
    method: 'POST', headers: jsonHeaders(bob.cookie), body: JSON.stringify({ body: 'It closes at 8 PM.' })
  });
  assert.equal(answered.response.status, 201);
  assert.equal(answered.data.answer.author.id, bob.user.id);
  const answerId = answered.data.answer.id;

  const vote = await request(`/api/answers/${answerId}/vote`, { method: 'POST', headers: jsonHeaders(owner.cookie), body: '{}' });
  assert.equal(vote.response.status, 200);
  assert.equal(vote.data.votes, 1);

  const accepted = await request(`/api/questions/${questionId}/accept/${answerId}`, {
    method: 'POST', headers: jsonHeaders(alice.cookie), body: '{}'
  });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.data.acceptedAnswerId, answerId);

  const view = await request(`/api/questions/${questionId}`, { headers: { Cookie: alice.cookie } });
  const answer = view.data.question.answers.find(item => item.id === answerId);
  assert.equal(answer.author.id, bob.user.id);
  assert.equal(answer.accepted, true);
});

test('Global Search All includes matching Campus Q&A questions', async () => {
  const title = 'Orbital duck campus transport';
  const created = await request('/api/questions', {
    method: 'POST', headers: jsonHeaders(alice.cookie),
    body: JSON.stringify({ title, body: 'Where should this unusual transport question be discussed?', anonymous: false })
  });
  assert.equal(created.response.status, 201);

  const searched = await request('/api/search?q=orbital%20duck&type=all', { headers: { Cookie: bob.cookie } });
  assert.equal(searched.response.status, 200);
  const result = searched.data.items.find(item => item.id === created.data.question.id);
  assert.ok(result);
  assert.equal(result.type, 'qa');
  assert.equal(result.title, title);
  assert.equal(result.route, `question:${created.data.question.id}`);
});

test('Marketplace lifecycle uses DMs for contact and hides closed listings from public results', async () => {
  const created = await request('/api/marketplace', {
    method: 'POST', headers: jsonHeaders(alice.cookie),
    body: JSON.stringify({ type: 'sell', title: 'Scientific calculator', description: 'Working condition', category: 'Study', condition: 'Used', priceInr: 700, location: 'Library gate' })
  });
  assert.equal(created.response.status, 201);
  const listing = created.data.listing;
  assert.equal(listing.priceInr, 700);

  const contact = await request(`/api/marketplace/${listing.id}/contact`, { method: 'POST', headers: jsonHeaders(bob.cookie), body: '{}' });
  assert.equal(contact.response.status, 200);
  assert.ok(contact.data.conversationId);

  const closed = await request(`/api/marketplace/${listing.id}`, {
    method: 'PATCH', headers: jsonHeaders(alice.cookie), body: JSON.stringify({ status: 'sold' })
  });
  assert.equal(closed.response.status, 200);
  assert.equal(closed.data.listing.status, 'sold');

  const publicList = await request('/api/marketplace', { headers: { Cookie: bob.cookie } });
  assert.equal(publicList.data.listings.some(item => item.id === listing.id), false);
  const mine = await request('/api/marketplace?mine=1', { headers: { Cookie: alice.cookie } });
  assert.ok(mine.data.listings.some(item => item.id === listing.id && item.status === 'sold'));
});

test('Lost & Found contact uses DMs and returned items leave the active feed', async () => {
  const created = await request('/api/lost-found', {
    method: 'POST', headers: jsonHeaders(alice.cookie),
    body: JSON.stringify({ status: 'lost', name: 'Black notebook', description: 'Physics notes inside', location: 'Cafeteria', occurredOn: new Date().toISOString() })
  });
  assert.equal(created.response.status, 201);
  const item = created.data.item;

  const contact = await request(`/api/lost-found/${item.id}/contact`, { method: 'POST', headers: jsonHeaders(bob.cookie), body: '{}' });
  assert.equal(contact.response.status, 200);
  assert.ok(contact.data.conversationId);

  const returned = await request(`/api/lost-found/${item.id}`, {
    method: 'PATCH', headers: jsonHeaders(alice.cookie), body: JSON.stringify({ status: 'returned' })
  });
  assert.equal(returned.response.status, 200);
  assert.equal(returned.data.item.status, 'returned');

  const active = await request('/api/lost-found', { headers: { Cookie: bob.cookie } });
  assert.equal(active.data.items.some(entry => entry.id === item.id), false);
  const mine = await request('/api/lost-found?mine=1', { headers: { Cookie: alice.cookie } });
  assert.ok(mine.data.items.some(entry => entry.id === item.id && entry.status === 'returned'));
});

test('new users get onboarding once and keep normalized profile skills and availability', async () => {
  const before = await request('/api/profile/preferences', { headers: { Cookie: bob.cookie } });
  assert.equal(before.response.status, 200);
  assert.equal(before.data.onboardingComplete, false);

  const completed = await request('/api/onboarding/complete', {
    method: 'POST', headers: jsonHeaders(bob.cookie),
    body: JSON.stringify({ department: 'Computer Science', year: '2', interests: ['Robotics', 'Music'], skills: ['JavaScript', 'javascript', 'CAD'], availableForProjects: true })
  });
  assert.equal(completed.response.status, 200);
  assert.deepEqual(completed.data.skills.sort(), ['CAD', 'JavaScript']);

  const after = await request('/api/profile/preferences', { headers: { Cookie: bob.cookie } });
  assert.equal(after.data.onboardingComplete, true);
  assert.equal(after.data.availableForProjects, true);

  const summary = await request(`/api/profiles/${bob.user.username}/summary`, { headers: { Cookie: bob.cookie } });
  assert.deepEqual(summary.data.skills.sort(), ['CAD', 'JavaScript']);
  assert.equal(summary.data.availableForProjects, true);
});

test('event reminders catch up immediately when their due time has passed', async () => {
  const startsAt = new Date(Date.now() + 30 * 60000).toISOString();
  const event = await request('/api/events', {
    method: 'POST', headers: jsonHeaders(alice.cookie),
    body: JSON.stringify({ title: 'Quick meetup', description: 'Reminder test', startsAt, location: 'Quad', capacity: 20 })
  });
  assert.equal(event.response.status, 201);
  const eventId = event.data.event.id;

  const reminder = await request(`/api/events/${eventId}/reminder`, {
    method: 'PUT', headers: jsonHeaders(alice.cookie), body: JSON.stringify({ minutesBefore: 60 })
  });
  assert.equal(reminder.response.status, 200);

  const note = await db.get("SELECT * FROM notifications WHERE user_id=? AND kind='event_reminder' AND entity_id=?", [alice.user.id, eventId]);
  assert.ok(note);
  const stored = await db.get('SELECT sent_at FROM event_reminders WHERE event_id=? AND user_id=?', [eventId, alice.user.id]);
  assert.ok(stored.sent_at);
});
